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
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;

import javax.sql.DataSource;

import org.h2.jdbcx.JdbcDataSource;

/**
 * An in-memory H2 database with a CSV loaded into it.
 * <p>
 * The probe carries its own data so it needs nothing installed and nothing
 * configured: the file next to it is the whole dataset, and changing it changes
 * what the cubes answer.
 * <p>
 * The loader is deliberately plain rather than a CSV library. The file is one
 * this project wrote, so the parsing has one job - split on commas, trim - and a
 * dependency for that would be a dependency to keep.
 */
public final class CsvDatabase {

    private final DataSource dataSource;
    private final String tableName;
    private final List<String> columns = new ArrayList<>();
    private final List<String> types = new ArrayList<>();
    private int rowCount;

    private CsvDatabase(DataSource dataSource, String tableName) {
        this.dataSource = dataSource;
        this.tableName = tableName;
    }

    public DataSource dataSource() {
        return dataSource;
    }

    public String tableName() {
        return tableName;
    }

    public List<String> columns() {
        return List.copyOf(columns);
    }

    /** Whether a column holds numbers, which decides how the mapping measures it. */
    public boolean isNumeric(String column) {
        int index = columns.indexOf(column);
        return index >= 0 && "INTEGER".equals(types.get(index));
    }

    public int rowCount() {
        return rowCount;
    }

    /**
     * Reads {@code csv} into a fresh in-memory database and answers it.
     *
     * @param name the database name, so two probes in one process do not share one
     */
    public static CsvDatabase load(Path csv, String name, String tableName) throws IOException, SQLException {
        JdbcDataSource source = new JdbcDataSource();
        // DB_CLOSE_DELAY=-1 keeps the database alive while the process is, rather
        // than dropping it when the first connection closes - which the pool does
        // constantly.
        source.setURL("jdbc:h2:mem:" + name + ";DB_CLOSE_DELAY=-1;DATABASE_TO_UPPER=TRUE");
        source.setUser("sa");
        source.setPassword("");

        CsvDatabase database = new CsvDatabase(source, tableName);
        database.fill(Files.readAllLines(csv, StandardCharsets.UTF_8));
        return database;
    }

    private void fill(List<String> lines) throws SQLException {
        if (lines.isEmpty()) {
            throw new IllegalArgumentException("the csv is empty");
        }
        List<List<String>> rows = new ArrayList<>();
        for (String line : lines.subList(1, lines.size())) {
            if (!line.isBlank()) {
                rows.add(split(line));
            }
        }
        for (String header : split(lines.get(0))) {
            columns.add(header.toUpperCase(java.util.Locale.ROOT));
        }
        // A column is a number when every value in it is one. Deciding from the
        // data rather than from a declaration keeps the csv the only thing to
        // edit.
        for (int i = 0; i < columns.size(); i++) {
            types.add(allIntegers(rows, i) ? "INTEGER" : "VARCHAR(64)");
        }

        try (Connection connection = dataSource.getConnection(); Statement statement = connection.createStatement()) {
            // Quoted, every one of them. A csv may name a column MONTH or ORDER,
            // and an unquoted identifier that happens to be a reserved word
            // fails at CREATE TABLE with a syntax error that says nothing about
            // the file it came from.
            StringBuilder create = new StringBuilder("CREATE TABLE ").append(quote(tableName)).append(" (");
            for (int i = 0; i < columns.size(); i++) {
                create.append(i == 0 ? "" : ", ").append(quote(columns.get(i))).append(' ').append(types.get(i));
            }
            statement.execute(create.append(')').toString());
        }

        StringBuilder insert = new StringBuilder("INSERT INTO ").append(quote(tableName)).append(" VALUES (");
        for (int i = 0; i < columns.size(); i++) {
            insert.append(i == 0 ? "?" : ", ?");
        }
        insert.append(')');

        try (Connection connection = dataSource.getConnection();
                PreparedStatement statement = connection.prepareStatement(insert.toString())) {
            for (List<String> row : rows) {
                for (int i = 0; i < columns.size(); i++) {
                    String value = i < row.size() ? row.get(i) : "";
                    if ("INTEGER".equals(types.get(i))) {
                        statement.setInt(i + 1, Integer.parseInt(value));
                    } else {
                        statement.setString(i + 1, value);
                    }
                }
                statement.addBatch();
            }
            statement.executeBatch();
            rowCount = rows.size();
        }
    }

    /** An SQL identifier, quoted so a reserved word is still a name. */
    private static String quote(String identifier) {
        return '"' + identifier.replace("\"", "\"\"") + '"';
    }

    private static boolean allIntegers(List<List<String>> rows, int column) {
        if (rows.isEmpty()) {
            return false;
        }
        for (List<String> row : rows) {
            if (column >= row.size()) {
                return false;
            }
            try {
                Integer.parseInt(row.get(column));
            } catch (NumberFormatException notANumber) {
                return false;
            }
        }
        return true;
    }

    private static List<String> split(String line) {
        List<String> cells = new ArrayList<>();
        for (String cell : line.split(",", -1)) {
            cells.add(cell.trim());
        }
        return cells;
    }
}
