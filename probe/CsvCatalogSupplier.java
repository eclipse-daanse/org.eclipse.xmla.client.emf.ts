/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */

import java.util.ArrayList;
import java.util.List;

import org.eclipse.daanse.cwm.model.cwm.resource.relational.Column;
import org.eclipse.daanse.cwm.model.cwm.resource.relational.RelationalFactory;
import org.eclipse.daanse.cwm.model.cwm.resource.relational.Schema;
import org.eclipse.daanse.cwm.model.cwm.resource.relational.Table;
import org.eclipse.daanse.cwm.model.cwm.resource.relational.util.SQLSimpleTypes;
import org.eclipse.daanse.rolap.mapping.model.RolapMappingFactory;
import org.eclipse.daanse.rolap.mapping.model.catalog.Catalog;
import org.eclipse.daanse.rolap.mapping.model.catalog.CatalogFactory;
import org.eclipse.daanse.rolap.mapping.model.database.source.SourceFactory;
import org.eclipse.daanse.rolap.mapping.model.database.source.TableSource;
import org.eclipse.daanse.rolap.mapping.model.olap.cube.CubeFactory;
import org.eclipse.daanse.rolap.mapping.model.olap.cube.MeasureGroup;
import org.eclipse.daanse.rolap.mapping.model.olap.cube.PhysicalCube;
import org.eclipse.daanse.rolap.mapping.model.olap.cube.measure.CountMeasure;
import org.eclipse.daanse.rolap.mapping.model.olap.cube.measure.MeasureFactory;
import org.eclipse.daanse.rolap.mapping.model.olap.cube.measure.SumMeasure;
import org.eclipse.daanse.rolap.mapping.model.olap.dimension.DimensionConnector;
import org.eclipse.daanse.rolap.mapping.model.olap.dimension.DimensionFactory;
import org.eclipse.daanse.rolap.mapping.model.olap.dimension.StandardDimension;
import org.eclipse.daanse.rolap.mapping.model.olap.dimension.hierarchy.ExplicitHierarchy;
import org.eclipse.daanse.rolap.mapping.model.olap.dimension.hierarchy.HierarchyFactory;
import org.eclipse.daanse.rolap.mapping.model.olap.dimension.hierarchy.level.Level;
import org.eclipse.daanse.rolap.mapping.model.olap.dimension.hierarchy.level.LevelFactory;
import org.eclipse.daanse.rolap.mapping.model.provider.CatalogMappingSupplier;

/**
 * A ROLAP mapping over the columns the CSV actually has.
 * <p>
 * Built from {@link CsvDatabase} rather than written out, so the csv is the only
 * thing to edit: a text column becomes a dimension, a numeric one becomes a
 * measure, and adding a column to the file adds it to the cube. That is the same
 * idea the rest of this project runs on - the description is the model, and
 * nothing is stated twice.
 * <p>
 * One cube, one fact table, no aggregation tables: enough for a client to
 * discover a catalog, walk its cubes, dimensions, hierarchies and levels, and
 * run an MDX query that really is computed from rows in a database.
 */
public final class CsvCatalogSupplier implements CatalogMappingSupplier {

    private final CsvDatabase database;
    private final String catalogName;
    private final String cubeName;

    public CsvCatalogSupplier(CsvDatabase database, String catalogName, String cubeName) {
        this.database = database;
        this.catalogName = catalogName;
        this.cubeName = cubeName;
    }

    @Override
    public Catalog get() {
        Schema databaseSchema = RelationalFactory.eINSTANCE.createSchema();
        Table table = RelationalFactory.eINSTANCE.createTable();
        table.setName(database.tableName());

        List<Column> textual = new ArrayList<>();
        List<Column> numeric = new ArrayList<>();
        for (String name : database.columns()) {
            Column column = RelationalFactory.eINSTANCE.createColumn();
            column.setName(name);
            if (database.isNumeric(name)) {
                column.setType(SQLSimpleTypes.Sql99.integerType());
                numeric.add(column);
            } else {
                column.setType(SQLSimpleTypes.Sql99.varcharType());
                textual.add(column);
            }
            table.getFeature().add(column);
        }
        databaseSchema.getOwnedElement().add(table);

        TableSource source = SourceFactory.eINSTANCE.createTableSource();
        source.setTable(table);

        MeasureGroup measures = CubeFactory.eINSTANCE.createMeasureGroup();
        for (Column column : numeric) {
            SumMeasure measure = MeasureFactory.eINSTANCE.createSumMeasure();
            measure.setName(titleCase(column.getName()));
            measure.setColumn(column);
            measures.getMeasures().add(measure);
        }
        // A count so a client can ask how many rows are behind a cell, which is
        // the first thing anyone checks when a total looks wrong.
        CountMeasure rows = MeasureFactory.eINSTANCE.createCountMeasure();
        rows.setName("Row Count");
        rows.setColumn(numeric.isEmpty() ? textual.get(0) : numeric.get(0));
        measures.getMeasures().add(rows);

        PhysicalCube cube = CubeFactory.eINSTANCE.createPhysicalCube();
        cube.setName(cubeName);
        cube.setSource(source);
        cube.getMeasureGroups().add(measures);

        for (Column column : textual) {
            cube.getDimensionConnectors().add(dimensionOn(column, source));
        }

        Catalog catalog = CatalogFactory.eINSTANCE.createCatalog();
        catalog.setName(catalogName);
        catalog.setDescription("Loaded from a csv next to the probe");
        catalog.getCubes().add(cube);
        catalog.getDbschemas().add(databaseSchema);
        return catalog;
    }

    /** One text column, as a dimension with a single level. */
    private static DimensionConnector dimensionOn(Column column, TableSource source) {
        String name = titleCase(column.getName());

        Level level = LevelFactory.eINSTANCE.createLevel();
        level.setName(name);
        level.setColumn(column);

        ExplicitHierarchy hierarchy = HierarchyFactory.eINSTANCE.createExplicitHierarchy();
        hierarchy.setName(name);
        // With an All member, so a query that names no member of this dimension
        // still has something to aggregate to.
        hierarchy.setHasAll(true);
        hierarchy.setPrimaryKey(column);
        hierarchy.setSource(source);
        hierarchy.getLevels().add(level);

        StandardDimension dimension = DimensionFactory.eINSTANCE.createStandardDimension();
        dimension.setName(name);
        dimension.getHierarchies().add(hierarchy);

        DimensionConnector connector = DimensionFactory.eINSTANCE.createDimensionConnector();
        connector.setOverrideDimensionName(name);
        connector.setDimension(dimension);
        return connector;
    }

    /** REGION becomes Region, and ROW_COUNT would become Row Count. */
    private static String titleCase(String columnName) {
        StringBuilder out = new StringBuilder();
        for (String word : columnName.split("_")) {
            if (word.isEmpty()) {
                continue;
            }
            if (out.length() > 0) {
                out.append(' ');
            }
            out.append(Character.toUpperCase(word.charAt(0)))
                    .append(word.substring(1).toLowerCase(java.util.Locale.ROOT));
        }
        return out.toString();
    }
}
