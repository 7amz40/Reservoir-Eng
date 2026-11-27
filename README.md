# Havlena–Odeh analyzer

An interactive dashboard for PNGE 4412 Reservoir Engineering at Sultan Qaboos University.
Load an Excel file of production and PVT data and it finds the drive mechanism, then gives,
with the Havlena–Odeh straight-line method:

- the drive mechanism
- *N*, the stock-tank oil initially in place
- *m*, the ratio of the initial gas-cap volume to the oil-zone volume, and *G*, the gas-cap gas initially in place
- the water influx *W*<sub>e</sub> and the aquifer constant, when there is an aquifer
- the oil recovered so far, *RF* = *N*<sub>p</sub> / *N* at the latest step, and the oil that remains
- the drive indices at every step, and how much the answer moves when the table values are rounded
- a sketch of the reservoir: a cross-section in which the gas cap, the oil and the water that came in are drawn
  to scale at each pressure, with a slider and **Play** to step through the history

It opens with an example already loaded: a gas-cap oil reservoir, for which it finds a gas-cap drive
with *N* = 112.1 MMSTB, *m* = 0.500 and *G* = 80.7 Bscf, of which 15.8 % has been produced.

**Show calculations** works the whole method out with the numbers put in, set as a short paper with
numbered sections, equations and tables: the data, the equations, a sample calculation at a pressure you
pick (*R*<sub>p</sub>, *F*, *E*<sub>o</sub>, *E*<sub>g</sub>, *E*<sub>fw</sub>, *W*<sub>e</sub> and the point on the line), the same
terms at every pressure, the least-squares fit as a table of sums, and the results with the drive indices.
**Download PDF** in that window prints the same pages on A4, numbered at the foot; choose *Save as PDF*
in the print window.

**Print report** writes one A4 page in the style of a short technical paper: a summary, the method with
its numbered equations, the results table and the Havlena–Odeh plot, the input data and the references.
The print dialog can save it as a PDF. **Export results** writes the results and the full calculation
to an Excel file.

## How it finds the drive mechanism

It fits every mechanism the data allow:

| Mechanism | Straight line | Gives |
| --- | --- | --- |
| Depletion: solution gas, rock and water expansion | *F* against *E*<sub>t</sub>, through the origin | *N* |
| Gas cap | *F*/(*E*<sub>o</sub> + *E*<sub>f,w</sub>) against *E*<sub>g</sub>/(*E*<sub>o</sub> + *E*<sub>f,w</sub>) | *N*, *m* |
| Water drive | *F*/*E*<sub>t</sub> against *W*<sub>e</sub>/*E*<sub>t</sub>, slope 1 | *N*, aquifer constant |
| Gas cap and water | least squares on *F* = *N*(*E*<sub>o</sub> + *mE*<sub>g</sub> + (1 + *m*)*E*<sub>f,w</sub>) + *W*<sub>e</sub> | *N*, *m*, aquifer constant |

The aquifer can be a pot aquifer, *W*<sub>e</sub> = *K*(*p*<sub>i</sub> − *p*), a steady-state (Schilthuis)
aquifer, or an unsteady-state radial aquifer (van Everdingen–Hurst), for which it also finds
*r*<sub>e</sub>/*r*<sub>o</sub> and the dimensionless-time constant. The last two need a time or date column;
without one the rows can be taken as equal time steps. A *W*<sub>e</sub> column in the file is used as it is.

A mechanism is set aside when it needs a negative gas cap or water leaving the reservoir, when its
extra energy supplies under 2 % of *F*, when it cannot be told apart from rock and fluid expansion,
or when rounding the table within its last digit flips it. Of the rest, the best fit by AICc wins,
and the one with fewer constants wins a near tie.

The file needs *p*, *N*<sub>p</sub> and *B*<sub>o</sub>, plus *R*<sub>s</sub>, *B*<sub>g</sub> and *G*<sub>p</sub> (or *R*<sub>p</sub>) when the oil goes
below the bubble point; without them the oil is taken as undersaturated. Time or date, *W*<sub>p</sub>,
*W*<sub>e</sub> and a known *m* are optional. The initial values (*p*<sub>i</sub>, *B*<sub>oi</sub>, *B*<sub>gi</sub>, *R*<sub>si</sub>, *S*<sub>wc</sub>,
*c*<sub>w</sub>, *c*<sub>f</sub>) go on the same sheet or a second one; the template shows one way.

## Open it

Open `index.html` in Chrome, Edge, Firefox or Safari. Nothing to install and no server:
the file you load is read in the browser and never leaves your computer.
`dist/havlena-odeh-analyzer.html` is the same dashboard packed into one file.

## Sample files

| File | Built with | The dashboard finds |
| --- | --- | --- |
| `havlena-odeh-example.xlsx` | the example the dashboard opens with: a gas-cap oil reservoir, with *B*<sub>g</sub> in ft³/SCF and *G*<sub>p</sub> in MMMSCF, and *S*<sub>wc</sub> = 0.05, *c*<sub>w</sub> = 3 × 10⁻⁶ psi⁻¹ and *c*<sub>f</sub> = 4 × 10⁻⁶ psi⁻¹, so *E*<sub>f,w</sub> is included | gas cap, *N* = 112.1 MMSTB, *m* = 0.500, *G* = 80.7 Bscf |
| `known_answer_N150_m040.xlsx` | gas cap, *N* = 150 MMSTB, *m* = 0.40 | the same |
| `drive_depletion_N150.xlsx` | depletion, *N* = 150 MMSTB | the same |
| `drive_undersaturated_N150.xlsx` | above the bubble point, only *p*, *N*<sub>p</sub> and *B*<sub>o</sub> | depletion, *N* = 150 MMSTB |
| `drive_water_unsteady_N150.xlsx` | unsteady-state aquifer, *N* = 150 MMSTB, *U* = 9,000 rb/psi, *r*<sub>e</sub>/*r*<sub>o</sub> = 5, with a time column | the same |
| `drive_gascap_water_N150_m030.xlsx` | gas cap and pot aquifer, *N* = 150 MMSTB, *m* = 0.30, *K* = 30,000 rb/psi | the same |
| `havlena-odeh-template.xlsx` | a blank template | |

## What is in the folder

| Path | What it holds |
| --- | --- |
| `index.html`, `assets/css/styles.css` | Page layout and styles |
| `assets/js/units.js` | Number parsing and unit conversion |
| `assets/js/xlsxio.js` | Reads `.xlsx` and `.csv` files, writes `.xlsx` |
| `assets/js/parser.js` | Finds the table, the columns, the units and the initial parameters |
| `assets/js/mbe.js` | Material balance terms, the straight-line fits, *N*, *m*, *G*, drive indices, rounding check |
| `assets/js/drive.js` | Aquifer models, the fit of every mechanism and the choice between them |
| `assets/js/wdtable.js` | Van Everdingen–Hurst *W*<sub>D</sub>(*t*<sub>D</sub>) for a radial aquifer, made by `tools/make_wd_table.py` |
| `assets/js/charts.js`, `assets/js/app.js` | Charts and the dashboard itself |
| `assets/img/` | Sultan Qaboos University logo |
| `assets/vendor/` | d3 7.9.0 and JSZip 3.10.1, with their licences |
| `samples/` | The sample files above |
| `tests/` | Unit tests, browser tests and the test workbooks |
| `tools/build.py` | Rebuilds the single-file version in `dist/` |

## Tests

```
node --test tests/*.test.js         # 118 tests: units, file reading, table detection, calculation, drive mechanisms
python3 tests/e2e.py                # 18 checks in a real browser, the calculations, the sketch and the report included (needs playwright and openpyxl)
python3 tests/make_fixtures.py      # rebuilds the example, the template, the known-answer sample and tests/fixtures/
node tests/make_drive_samples.js    # rebuilds the drive_*.xlsx samples
python3 tools/build.py              # rebuilds dist/havlena-odeh-analyzer.html
```

The fixtures write one data set in many file layouts (two sheets, parameters below or beside the table,
units rows, shuffled and long headers, `Rp` instead of `Gp`, numbers stored as text,
percent and SI units, dates, CSV) and they all give the same answer. That data set, with *B*<sub>g</sub>
to only 1 or 2 significant figures, also checks the rounding check and the water-drive detection.
Exact data built from the material balance check that each mechanism is found and that the
method gives back the *N*, *m* and aquifer constants used to build them, and the same data
rounded like a textbook table check that the choice holds.
