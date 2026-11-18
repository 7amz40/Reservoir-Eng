# Havlena–Odeh analyzer

An interactive dashboard for PNGE 4412 Reservoir Engineering at Sultan Qaboos University.
It reads production and PVT data from an Excel file and finds, with the Havlena–Odeh
straight-line method:

- *N*, the stock-tank oil initially in place
- *m*, the ratio of the initial gas-cap volume to the oil-zone volume
- *G*, the gas-cap gas initially in place

For a combination drive it can take water influx *W*<sub>e</sub> off *F* before the fit,
from a *W*<sub>e</sub> column in the file or from a pot aquifer, *W*<sub>e</sub> = *K*(*p*<sub>i</sub> − *p*),
whose *K* you change by trial and error or let the dashboard find.
It also checks how much the answer moves when the table values are rounded.

It opens with an example data set already loaded.

## Open it

Open `index.html` in Chrome, Edge, Firefox or Safari. Nothing to install and no server:
the file you load is read in the browser and never leaves your computer.
`dist/havlena-odeh-analyzer.html` is the same dashboard packed into one file.

## What is in the folder

| Path | What it holds |
| --- | --- |
| `index.html`, `assets/css/styles.css` | Page layout and styles |
| `assets/js/units.js` | Number parsing and unit conversion |
| `assets/js/xlsxio.js` | Reads `.xlsx` and `.csv` files, writes `.xlsx` |
| `assets/js/parser.js` | Finds the table, the columns, the units and the initial parameters |
| `assets/js/mbe.js` | Material balance terms, water influx, the straight-line fit, *N*, *m*, *G*, drive indices, rounding check |
| `assets/js/charts.js`, `assets/js/app.js` | Charts and the dashboard itself |
| `assets/img/` | Sultan Qaboos University logo |
| `assets/vendor/` | d3 7.9.0 and JSZip 3.10.1, with their licences |
| `samples/` | The example data set, a blank template, a second example, and a file with a known answer |
| `tests/` | Unit tests, browser tests and the test workbooks |
| `tools/build.py` | Rebuilds the single-file version in `dist/` |

## Tests

```
node --test tests/*.test.js     # 69 tests: units, file reading, table detection, calculation
python3 tests/e2e.py            # 13 checks in a real browser (needs playwright and openpyxl)
python3 tests/make_fixtures.py  # rebuilds samples/ and tests/fixtures/
python3 tools/build.py          # rebuilds dist/havlena-odeh-analyzer.html
```

The fixtures cover many file layouts (two sheets, parameters below or beside the table,
units rows, shuffled and long headers, `Rp` instead of `Gp`, numbers stored as text,
percent and SI units, CSV) and they all give the same answer for the example data.
Exact synthetic data built from the material balance check that the method gives back
the *N*, *m* and aquifer *K* used to build them.
