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
import java.util.List;

import javax.xml.stream.XMLStreamException;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;

import org.eclipse.daanse.xmla.api.SimpleSessionHandler;
import org.eclipse.daanse.xmla.api.XmlaConnector;
import org.eclipse.daanse.xmla.api.XmlaRequest;
import org.eclipse.daanse.xmla.api.auth.AuthenticationChain;
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

        System.out.println("probe listening on http://localhost:" + port + contextPath);
        System.out.flush();
        Runtime.getRuntime().addShutdownHook(new Thread(() -> server.stop(0)));
        Thread.currentThread().join();
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

        @Override
        public EObject execute(Execute request, XmlaRequest context) {
            // Statements are outside what this probe answers; sessions and the
            // envelope are what it is here for, and those go through Execute
            // with no command at all.
            return null;
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
