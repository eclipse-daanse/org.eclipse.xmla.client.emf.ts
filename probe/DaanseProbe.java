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
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.Set;

import javax.xml.stream.XMLStreamException;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;

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
import org.eclipse.daanse.xmla.model.rowset.RowsetFactory;
import org.eclipse.daanse.xmla.model.rowset.RowsetPackage;
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

        HttpServer server = HttpServer.create(new InetSocketAddress(port), 0);
        // SimpleSessionHandler leaves its policy hooks abstract on purpose; a
        // probe takes the permissive answer to each.
        SimpleSessionHandler sessions = new SimpleSessionHandler() {
        };
        EmfXmlaAdapter adapter = new EmfXmlaAdapter(new StandInConnector(), sessions, null,
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
        EmfXmlaAdapter guarded = new EmfXmlaAdapter(new StandInConnector(), new SimpleSessionHandler() {
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

    /**
     * A backend with just enough in it to be worth asking.
     * <p>
     * One rowset is derived from the model and therefore real;
     * the other two carry a couple of rows so the client has something with
     * values in it to read, and one of them is deliberately left with a NULL
     * column so the distinction between absent and empty is exercised end to
     * end.
     */
    private static final class StandInConnector implements XmlaConnector {

        @Override
        public List<EObject> discover(Discover request, XmlaRequest context) {
            String requestType = request.getRequestType().getLiteral();

            if ("DISCOVER_SCHEMA_ROWSETS".equals(requestType)) {
                // Not invented: the model's own account of every rowset it
                // describes, which is what the real server answers here too.
                return RowsetCatalog.schemaRowsets();
            }
            // The row class comes from the catalogue rather than from a
            // generated getter, for the same reason everything else here does:
            // the model is the description, and naming a class by hand would be
            // one more thing that can fall behind it.
            EClass rowClass = RowsetCatalog.forRequestType(requestType).orElse(null);
            if (rowClass == null) {
                throw new IllegalArgumentException("no rowset called " + requestType);
            }

            if ("DISCOVER_DATASOURCES".equals(requestType)) {
                return List.of(row(rowClass, "dataSourceName", "Daanse Probe", "dataSourceInfo", "Provider=Daanse",
                        "providerName", "Daanse", "url", "http://localhost:8090/xmla"));
            }
            if ("DBSCHEMA_CATALOGS".equals(requestType)) {
                return List.of(
                        row(rowClass, "catalogName", "Probe Catalog", "description", "a catalog with a description"),
                        // The second leaves DESCRIPTION unset, which is how NULL
                        // is said - the client has to tell that from "".
                        row(rowClass, "catalogName", "Silent Catalog"));
            }
            // A rowset the model knows and this backend has no data for. An
            // empty list is a legitimate answer; failure would be an exception.
            return List.of();
        }

        /**
         * A small but complete MDX result.
         * <p>
         * Two measures across two months, with one cell deliberately left out so
         * a client has to place cells by their ordinal rather than by counting -
         * a result is sparse, and a reader that assumes otherwise puts values in
         * the wrong squares.
         * <p>
         * Only the numbers are made up. The shape - OlapInfo, the axes, the
         * tuples, the cell properties - and everything that turns it into XML is
         * the project's own.
         */
        @Override
        public EObject execute(Execute request, XmlaRequest context) {
            if (request.getCommand() == null) {
                // BeginSession and EndSession carry an empty Statement and
                // produce nothing, which is the specification's empty result.
                return null;
            }
            MdDatasetFactory factory = MdDatasetFactory.eINSTANCE;

            MdDataset dataset = factory.createMdDataset();
            OlapInfo info = factory.createOlapInfo();
            CubeInfo cubes = factory.createCubeInfo();
            OlapInfoCube cube = factory.createOlapInfoCube();
            cube.setCubeName("Probe");
            cubes.getCube().add(cube);
            info.setCubeInfo(cubes);
            info.setAxesInfo(factory.createAxesInfo());
            info.setCellInfo(factory.createCellInfo());
            dataset.setOlapInfo(info);

            Axes axes = factory.createAxes();
            axes.getAxis().add(axis(factory, "Axis0", new String[][] {
                { "[Measures]", "[Measures].[Amount]", "Amount" },
                { "[Measures]", "[Measures].[Count]", "Count" } }));
            axes.getAxis().add(axis(factory, "Axis1", new String[][] {
                { "[Time]", "[Time].[2026].[January]", "January" },
                { "[Time]", "[Time].[2026].[February]", "February" } }));
            axes.getAxis().add(axis(factory, "SlicerAxis", new String[][] {
                { "[Region]", "[Region].[All]", "All Regions" } }));
            dataset.setAxes(axes);

            CellData data = factory.createCellData();
            // Axis 0 varies fastest: ordinal 0 is (Amount, January), 1 is
            // (Count, January), 2 is (Amount, February).
            data.getCell().add(cell(factory, 0, "1234.5", "xsd:double", "$1,234.50"));
            data.getCell().add(cell(factory, 1, "17", "xsd:int", "17"));
            data.getCell().add(cell(factory, 2, "987.25", "xsd:double", "$987.25"));
            // Ordinal 3 is absent on purpose: no value, no cell.
            dataset.setCellData(data);

            return dataset;
        }

        private static Axis axis(MdDatasetFactory factory, String name, String[][] members) {
            Axis axis = factory.createAxis();
            axis.setName(name);
            TuplesType tuples = factory.createTuplesType();
            for (String[] member : members) {
                TupleType tuple = factory.createTupleType();
                tuple.getMember().add(member(factory, member[0], member[1], member[2]));
                tuples.getTuple().add(tuple);
            }
            axis.getSetType().add(tuples);
            return axis;
        }

        private static MemberType member(MdDatasetFactory factory, String hierarchy, String uniqueName,
                String caption) {
            MemberType member = factory.createMemberType();
            member.setHierarchy(hierarchy);
            member.getAny().add(property(factory, "UName", uniqueName));
            member.getAny().add(property(factory, "Caption", caption));
            member.getAny().add(property(factory, "LName", hierarchy + ".[Level]"));
            member.getAny().add(property(factory, "LNum", "0"));
            return member;
        }

        private static CellType cell(MdDatasetFactory factory, long ordinal, String value, String type,
                String formatted) {
            CellType cell = factory.createCellType();
            cell.setCellOrdinal(ordinal);
            CellTypeValue held = factory.createCellTypeValue();
            held.setValue(value);
            held.setType(type);
            cell.setValue(held);
            cell.getAny().add(property(factory, "FmtValue", formatted));
            return cell;
        }

        private static CellProperty property(MdDatasetFactory factory, String tagName, String value) {
            CellProperty property = factory.createCellProperty();
            property.setTagName(tagName);
            property.setValue(value);
            return property;
        }

        /** A row of {@code eClass}, from feature-name and value pairs. */
        private static EObject row(EClass eClass, String... nameThenValue) {
            EObject row = EcoreUtil.create(eClass);
            for (int i = 0; i + 1 < nameThenValue.length; i += 2) {
                org.eclipse.emf.ecore.EStructuralFeature feature = eClass.getEStructuralFeature(nameThenValue[i]);
                if (feature == null) {
                    throw new IllegalStateException(eClass.getName() + " has no " + nameThenValue[i]);
                }
                row.eSet(feature, nameThenValue[i + 1]);
            }
            return row;
        }
    }

    static {
        // A generated EPackage registers itself when its class initialises.
        RowsetFactory.eINSTANCE.getClass();
    }
}
