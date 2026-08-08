# Getting the raw data

The pipeline consumes three Postgres tables of US Department of Labor OFLC
disclosure data. This page is what `README.md`'s one-liner ("needs a local
Postgres holding...") glosses over: where the files come from, how they map to
tables, and how to load them.

## Source

DOL OFLC publishes quarterly disclosure files (xlsx) at:

https://www.dol.gov/agencies/eta/foreign-labor/performance

Under "Disclosure Data", download per fiscal year and quarter:

| DOL program | Files | Table |
| --- | --- | --- |
| LCA (H-1B, H-1B1, E-3) | `LCA_Disclosure_Data_FY20xx_Qx.xlsx` | `lca_disclosure` |
| Prevailing Wage (PWD) | `PWD_Disclosure_Data_FY20xx.xlsx` | `pwd_disclosure` |
| PERM | `PERM_Disclosure_Data_FY20xx.xlsx` | `perm_disclosure` |

This build covers FY2020 through FY2026-Q2. Column layouts drift between
years (most importantly: `employer_fein` exists only from FY2024 on, which is
why the whole employer-identity resolution in `sql/03_populate.sql` exists).
The DDL in `sql/02_raw_schema.sql` is the superset layout actually used,
dumped from the live database.

## Load

1. Create the tables:

```bash
psql -d lca -f sql/02_raw_schema.sql
```

2. Convert each xlsx sheet to CSV (any tool; `python -c` with openpyxl or
   `ssconvert` both work) and `COPY` it in, mapping the sheet's columns by
   name onto the table's columns. Columns present in the table but absent
   from an older year's file stay NULL, which the downstream normalizers
   expect. Add `source_fiscal_year` and `source_quarter` from the filename.

3. Sanity-check row counts per source file against the sheet row counts, then
   run the curated build:

```bash
python etl/build.py
```

`build.py` fails loudly if the value distributions differ from what the
normalizers were derived against (its `EXPECTED` gates and the year-coverage
check). If DOL renames a column in a future drop, step 2 is where it surfaces.

## What the pipeline never does

The raw tables are read-only to everything in this repo: `build.py` creates
and rewrites the `sponsors` schema, and nothing ever writes to `public`.
Roughly 40 of the LCA columns (named-individual contact details) are never
selected by any query in `sql/`.
