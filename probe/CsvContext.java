/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */

import java.util.Map;

import javax.sql.DataSource;

import org.eclipse.daanse.jdbc.datasource.pools.api.ConnectionPool;
import org.eclipse.daanse.jdbc.datasource.pools.hikari.api.HikariConnectionPools;
import org.eclipse.daanse.mdx.parser.ccc.CCCMdxParserProvider;
import org.eclipse.daanse.olap.api.function.FunctionService;
import org.eclipse.daanse.olap.calc.base.compiler.BaseExpressionCompilerFactory;
import org.eclipse.daanse.olap.function.services.standard.StandardFunctions;
import org.eclipse.daanse.rolap.core.internal.BasicContext;
import org.eclipse.daanse.rolap.function.def.intersect.IntersectResolver;
import org.eclipse.daanse.rolap.function.def.visualtotals.VisualTotalsResolver;
import org.eclipse.daanse.rolap.mapping.model.provider.CatalogMappingSupplier;
import org.eclipse.daanse.sql.dialect.api.Dialect;
import org.eclipse.daanse.sql.dialect.api.DialectFactory;
import org.eclipse.daanse.sql.dialect.api.DialectInitData;
import org.eclipse.daanse.sql.dialect.db.h2.H2Dialect;

/**
 * A ROLAP context wired by hand, without OSGi and without the testkit.
 * <p>
 * {@code BasicContext} is a declarative-services component: six of its
 * collaborators are mandatory references that a container would inject. Outside
 * one they have to be set, and each is the standard implementation - the CCC MDX
 * parser, the base expression compiler, the standard function service, a Hikari
 * pool over the DataSource, and a dialect fixed to H2 because the database is
 * this process's own and there is nothing to detect.
 * <p>
 * That list is the whole of it. Nothing here is a stub: the queries this context
 * answers are compiled, turned into SQL, run against H2 and aggregated by the
 * real engine.
 */
public final class CsvContext extends BasicContext {

    private final ConnectionPool pool;

    public CsvContext(DataSource dataSource, CatalogMappingSupplier catalog) {
        this.pool = HikariConnectionPools.create(dataSource);
        setConnectionPool(pool);
        setDialectFactory(new FixedDialect(new H2Dialect()));
        setCatalogMappingSupplier(catalog);
        setExpressionCompilerFactory(new BaseExpressionCompilerFactory());
        setMdxParserProvider(new CCCMdxParserProvider());
        setFunctionService(standardFunctions());
        try {
            activate(Map.of());
        } catch (Exception refused) {
            throw new IllegalStateException("the ROLAP context would not start", refused);
        }
    }

    /**
     * The standard function service, plus the two resolvers that live in the
     * ROLAP bundle rather than in the function bundle.
     */
    private static FunctionService standardFunctions() {
        FunctionService functions = StandardFunctions.standard();
        functions.addResolver(new IntersectResolver());
        functions.addResolver(new VisualTotalsResolver());
        return functions;
    }

    @Override
    public void deactivate(Map<String, Object> configuration) throws Exception {
        try {
            super.deactivate(configuration);
        } finally {
            pool.close();
        }
    }

    /** The database is this process's own, so there is nothing to detect. */
    private record FixedDialect(Dialect dialect) implements DialectFactory {
        @Override
        public Dialect createDialect(DialectInitData init) {
            return dialect;
        }
    }
}
