/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.file.Path;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.Set;

import javax.xml.stream.XMLStreamException;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;

import org.eclipse.daanse.olap.core.BasicContextGroup;
import org.eclipse.daanse.olap.xmla.connector.EmbeddedXmla;
import org.eclipse.daanse.xmla.api.SimpleSessionHandler;
import org.eclipse.daanse.xmla.api.XmlaConnector;
import org.eclipse.daanse.xmla.api.XmlaRequest;
import org.eclipse.daanse.xmla.api.auth.AuthenticatedIdentity;
import org.eclipse.daanse.xmla.api.auth.AuthenticationChain;
import org.eclipse.daanse.xmla.api.auth.XmlaAuthenticator;
import org.eclipse.daanse.xmla.model.mddataset.Axes;
import org.eclipse.daanse.xmla.model.mddataset.Axis;
import org.eclipse.daanse.xmla.model.mddataset.CellData;
import org.eclipse.daanse.xmla.model.mddataset.CellProperty;
import org.eclipse.daanse.xmla.model.mddataset.CellType;
import org.eclipse.daanse.xmla.model.mddataset.CellTypeValue;
import org.eclipse.daanse.xmla.model.mddataset.CubeInfo;
import org.eclipse.daanse.xmla.model.mddataset.MdDataset;
import org.eclipse.daanse.xmla.model.mddataset.MdDatasetFactory;
import org.eclipse.daanse.xmla.model.mddataset.MemberType;
import org.eclipse.daanse.xmla.model.mddataset.OlapInfo;
import org.eclipse.daanse.xmla.model.mddataset.OlapInfoCube;
import org.eclipse.daanse.xmla.model.mddataset.TupleType;
import org.eclipse.daanse.xmla.model.mddataset.TuplesType;
import org.eclipse.daanse.xmla.model.io.RowsetCatalog;
import org.eclipse.daanse.xmla.model.io.XmlaMessageCodec;
import org.eclipse.daanse.xmla.model.rowset.registry.RowsetPackages;
import org.eclipse.daanse.xmla.model.xmla.Discover;
import org.eclipse.daanse.xmla.model.xmla.Execute;
import org.eclipse.daanse.xmla.server.adapter.emf.AccessPolicy;
import org.eclipse.daanse.xmla.server.adapter.emf.EmfXmlaAdapter;
import org.eclipse.daanse.xmla.server.jdk.httpserver.EmfXmlaHttpHandler;
import org.eclipse.emf.ecore.EAnnotation;
import org.eclipse.emf.ecore.EAttribute;
import org.eclipse.emf.ecore.EClass;
import org.eclipse.emf.ecore.EcoreFactory;
import org.eclipse.emf.ecore.EObject;
import org.eclipse.emf.ecore.EPackage;
import org.eclipse.emf.ecore.util.EcoreUtil;
import org.eclipse.emf.ecore.util.ExtendedMetaData;
import org.eclipse.emf.ecore.xml.type.XMLTypePackage;

/**
 * A real Daanse XMLA server, on a port, for the TypeScript client to talk to.
 * <p>
 * Everything that decides what goes on the wire is the project's own: the SOAP
 * envelope, the session handling, the inline schema, the rowset serialisation.
 * Only the backend is stood in for, because standing up ROLAP with a catalog
 * and a data source is a different stack in a different repository, and this
 * exists to answer one question - does the client talk to an implementation
 * that is not itself.
 * <p>
 * What it serves is not made up either. {@code DISCOVER_SCHEMA_ROWSETS} is
 * derived from the model by {@link RowsetCatalog}, which is how the real server
 * answers it, so what the client reads back is the model's own account of all
 * 103 rowsets and their restrictions.
 * <p>
 * Started from {@code scripts/probe.mjs}; see that for the classpath.
 */
public final class DaanseProbe {

    private DaanseProbe() {
        // a main class
    }

    public static void main(String[] args) throws Exception {
        int port = args.length > 0 ? Integer.parseInt(args[0]) : 8090;
        String contextPath = args.length > 1 ? args[1] : "/xmla";
        // A second endpoint that insists on knowing who is asking. Everything
        // about how it insists - the chain, the challenge, the 401, the policy
        // that lets a client probe before it logs in - is the project's own.
        int securePort = args.length > 2 ? Integer.parseInt(args[2]) : port + 1;

        // The backend: a csv next to this file, in an H2 database this process
        // owns, described by a ROLAP mapping built from the csv's own columns.
        Path csv = Path.of(System.getProperty("probe.csv",
                Path.of(System.getProperty("user.dir"), "probe", "data", "sales.csv").toString()));
        CsvDatabase database = CsvDatabase.load(csv, "probe", "SALES");
        CsvContext context = new CsvContext(database.dataSource(),
                new CsvCatalogSupplier(database, "Daanse Probe", "Sales"));

        BasicContextGroup contexts = new BasicContextGroup();
        contexts.activate(null, Map.of());
        contexts.bindContext(context);
        XmlaConnector connector = EmbeddedXmla.connector(contexts);

        System.out.println("loaded " + database.rowCount() + " row(s) from " + csv);
        System.out.println("  columns: " + database.columns());

        HttpServer server = HttpServer.create(new InetSocketAddress(port), 0);
        // SimpleSessionHandler leaves its policy hooks abstract on purpose; a
        // probe takes the permissive answer to each.
        SimpleSessionHandler sessions = new SimpleSessionHandler() {
        };
        EmfXmlaAdapter adapter = new EmfXmlaAdapter(connector, sessions, null,
                // Open, because this is a probe and not a deployment. What the
                // client needs to exercise here is the protocol, not the policy.
                AccessPolicy.OPEN);
        server.createContext(contextPath,
                new EmfXmlaHttpHandler(adapter, null, AuthenticationChain::new, "*"));
        // A second endpoint that answers a rowset no model describes. See
        // ForeignRowsetHandler for why that cannot be done through the adapter.
        server.createContext(contextPath + "-foreign", new ForeignRowsetHandler());
        server.setExecutor(java.util.concurrent.Executors.newFixedThreadPool(4));
        server.start();

        HttpServer secure = HttpServer.create(new InetSocketAddress(securePort), 0);
        AuthenticationChain chain = new AuthenticationChain();
        chain.add(new StandInBasicAuthenticator(), Map.of());
        EmfXmlaAdapter guarded = new EmfXmlaAdapter(connector, new SimpleSessionHandler() {
        }, null,
                // A principal is required, except for the two rowsets a client
                // probes with before it has one. That is not a nicety: Excel and
                // SSMS both ask those two before they authenticate, and a server
                // that challenges them refuses the connection outright.
                new AccessPolicy(true, Set.of("DISCOVER_PROPERTIES", "DISCOVER_DATASOURCES")));
        secure.createContext(contextPath, new EmfXmlaHttpHandler(guarded, null, () -> chain, "*"));
        secure.setExecutor(java.util.concurrent.Executors.newFixedThreadPool(2));
        secure.start();

        System.out.println("probe listening on http://localhost:" + port + contextPath);
        System.out.println("guarded probe on http://localhost:" + securePort + contextPath
                + " (Basic " + USER + "/" + PASSWORD + ")");
        System.out.flush();
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            server.stop(0);
            secure.stop(0);
        }));
        Thread.currentThread().join();
    }

    static final String USER = "aladdin";
    static final String PASSWORD = "open sesame";

    /**
     * Basic, checked against one hard-coded pair.
     * <p>
     * Only the check is stood in for. The chain that calls this, the ordering,
     * the {@code WWW-Authenticate} challenge and the 401 that carries it are all
     * the project's own code, and they are what the client has to get right.
     */
    private static final class StandInBasicAuthenticator implements XmlaAuthenticator {

        @Override
        public String scheme() {
            return "Basic";
        }

        @Override
        public String challenge() {
            return "Basic realm=\"Daanse Probe\"";
        }

        @Override
        public Result authenticate(XmlaRequest request) {
            String header = firstHeader(request, "authorization");
            if (header == null || !header.regionMatches(true, 0, "Basic ", 0, 6)) {
                // Not ours: the chain moves on, and a request nobody claims is
                // not challenged here but where the backend refuses it.
                return new Result.NotMine();
            }
            String decoded;
            try {
                decoded = new String(Base64.getDecoder().decode(header.substring(6).trim()),
                        StandardCharsets.UTF_8);
            } catch (IllegalArgumentException notBase64) {
                return new Result.Refused("the credentials are not base64");
            }
            int colon = decoded.indexOf(':');
            if (colon < 0) {
                return new Result.Refused("the credentials carry no colon");
            }
            String user = decoded.substring(0, colon);
            String password = decoded.substring(colon + 1);
            if (!USER.equals(user) || !PASSWORD.equals(password)) {
                return new Result.Refused("wrong user or password");
            }
            return Result.Authenticated.of(AuthenticatedIdentity.of(() -> user));
        }

        private static String firstHeader(XmlaRequest request, String name) {
            for (Map.Entry<String, List<String>> entry : request.headers().entrySet()) {
                if (entry.getKey().equalsIgnoreCase(name) && !entry.getValue().isEmpty()) {
                    return entry.getValue().get(0);
                }
            }
            return null;
        }
    }

    /**
     * A rowset this project has no model for, written by the real writer.
     * <p>
     * The dynamic path claims that a server describing itself is enough - that a
     * client can read a rowset nobody modelled. Nothing had ever tested that
     * over a wire, because the only servers to hand are driven by the very model
     * the client already has.
     * <p>
     * This cannot go through {@link EmfXmlaAdapter}: it looks the row class up
     * in {@link RowsetCatalog} by request type and refuses what it does not
     * find, which is correct of it. So the response is written directly by
     * {@link XmlaMessageCodec} - the same code the adapter uses, including the
     * inline schema derived from the class - over an EClass built here at
     * runtime and present in no {@code .ecore} anywhere.
     */
    private static final class ForeignRowsetHandler implements HttpHandler {

        private static final String NS = "urn:schemas-microsoft-com:xml-analysis:rowset";

        @Override
        public void handle(HttpExchange exchange) throws IOException {
            EClass rowClass = foreignRowClass();
            List<EObject> rows = List.of(foreignRow(rowClass, "pool-one", 4, true),
                    foreignRow(rowClass, "pool-two", 16, false));

            exchange.getResponseHeaders().add("Content-Type", "text/xml; charset=utf-8");
            exchange.sendResponseHeaders(200, 0);
            try (OutputStream body = exchange.getResponseBody()) {
                XmlaMessageCodec.writeDiscoverResponse(body, List.of(), rowClass, rows.iterator());
            } catch (XMLStreamException unwritable) {
                throw new IOException(unwritable);
            }
        }

        /**
         * Built here and nowhere else: three columns with types no rowset in the
         * model happens to combine, so a client that reads them got the shape
         * from the response and not from something it already knew.
         */
        private static EClass foreignRowClass() {
            EPackage ePackage = EcoreFactory.eINSTANCE.createEPackage();
            ePackage.setName("foreign");
            ePackage.setNsPrefix("foreign");
            ePackage.setNsURI("urn:daanse:probe:foreign");

            EClass row = EcoreFactory.eINSTANCE.createEClass();
            row.setName("ForeignRow");
            annotate(row, ExtendedMetaData.ANNOTATION_URI, "name", "row", "kind", "elementOnly");
            ePackage.getEClassifiers().add(row);

            column(row, "poolName", "POOL_NAME", XMLTypePackage.eINSTANCE.getString());
            column(row, "threadCount", "THREAD_COUNT", XMLTypePackage.eINSTANCE.getIntObject());
            column(row, "isDefault", "IS_DEFAULT", XMLTypePackage.eINSTANCE.getBooleanObject());
            return row;
        }

        private static void column(EClass owner, String name, String wireName,
                org.eclipse.emf.ecore.EDataType type) {
            EAttribute attribute = EcoreFactory.eINSTANCE.createEAttribute();
            attribute.setName(name);
            attribute.setEType(type);
            attribute.setLowerBound(0);
            attribute.setUpperBound(1);
            annotate(attribute, ExtendedMetaData.ANNOTATION_URI, "kind", "element", "name", wireName, "namespace",
                    NS);
            owner.getEStructuralFeatures().add(attribute);
        }

        private static void annotate(org.eclipse.emf.ecore.EModelElement target, String source,
                String... keyThenValue) {
            EAnnotation annotation = EcoreFactory.eINSTANCE.createEAnnotation();
            annotation.setSource(source);
            for (int i = 0; i + 1 < keyThenValue.length; i += 2) {
                annotation.getDetails().put(keyThenValue[i], keyThenValue[i + 1]);
            }
            target.getEAnnotations().add(annotation);
        }

        private static EObject foreignRow(EClass rowClass, String pool, int threads, boolean isDefault) {
            EObject row = EcoreUtil.create(rowClass);
            row.eSet(rowClass.getEStructuralFeature("poolName"), pool);
            row.eSet(rowClass.getEStructuralFeature("threadCount"), threads);
            row.eSet(rowClass.getEStructuralFeature("isDefault"), isDefault);
            return row;
        }
    }


    static {
        // The rowsets live in five packages now, and the catalogue is told which
        // rather than naming any itself. This both registers the EPackages - a
        // generated one registers itself when its class initialises - and gives the
        // catalogue the model it refuses to work without.
        RowsetCatalog.use(RowsetPackages.all());
    }
}
