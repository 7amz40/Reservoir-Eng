"""
Builds the sample workbooks (samples/) and the test fixtures (tests/fixtures/).

    python3 tests/make_fixtures.py

Needs openpyxl. LibreOffice (soffice) is used, when present, to make the .xls, .ods and
LibreOffice-saved .xlsx variants that check the reader's error messages and compatibility.
"""
import csv
import math
import os
import random
import shutil
import subprocess
import tempfile

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIX = os.path.join(ROOT, "tests", "fixtures")
SAMPLES = os.path.join(ROOT, "samples")

HEAD_FILL = PatternFill("solid", fgColor="E6EFEA")
BOLD = Font(bold=True)

# ---------------------------------------------------------------- data

# Example data set: a gas-cap oil reservoir. Q2_HEADER keeps a "Bg (rb/STB)" label slip on purpose,
# because the reader must treat it as rb/SCF; the sample file uses the correct label.
Q2_HEADER = ["P (psia)", "Rs (SCF/STB)", "Bo (rb/STB)", "Bg (rb/STB)", "Np (MMSTB)", "Gp (MMSCF)"]
Q2_ROWS = [
    [2740, 650, 1.404, 0.0009, 0.00, 0],
    [2500, 592, 1.374, 0.0010, 7.88, 5988.8],
    [2290, 545, 1.349, 0.0011, 18.42, 15565],
    [2109, 507, 1.329, 0.0012, 29.15, 26818],
    [1949, 471, 1.316, 0.0013, 40.69, 39673],
    [1818, 442, 1.303, 0.0014, 50.14, 51394],
    [1702, 418, 1.294, 0.0015, 58.42, 62217],
    [1608, 398, 1.287, 0.0016, 65.39, 71603],
    [1535, 383, 1.280, 0.0017, 70.74, 79229],
    [1480, 370, 1.276, 0.0018, 74.54, 85348],
    [1440, 362, 1.273, 0.0018, 77.43, 89819],
]
Q2_PARAMS = [
    ("Initial pressure, pi", 2740, "psia"),
    ("Initial oil FVF, Boi", 1.404, "rb/STB"),
    ("Initial gas FVF, Bgi", 0.0009, "rb/SCF"),
    ("Initial solution GOR, Rsi", 650, "SCF/STB"),
    ("Connate water saturation, Swc", 0.05, "fraction"),
    ("Water compressibility, Cw", 3.0e-6, "1/psi"),
    ("Formation compressibility, Cf", 4.0e-6, "1/psi"),
    ("Porosity", 0.25, "fraction"),
]

# Second example: gas-cap reservoir with Bg in ft3/SCF and Gp in MMMSCF.
Q1_HEADER = ["Pressure (psia)", "Np (MMSTB)", "Gp (MMMSCF)", "Bo (bbl/STB)", "Rs (SCF/STB)", "Bg (cuft/SCF)"]
Q1_ROWS = [
    [3300, 0, 0, 1.2511, 510, 0.00488505],
    [3150, 3.295, 3.460, 1.2353, 477, 0.00516580],
    [3000, 5.903, 6.257, 1.2222, 450, 0.00539040],
    [2850, 8.852, 10.268, 1.2122, 425, 0.00567115],
    [2700, 11.503, 14.206, 1.2022, 401, 0.00600805],
    [2550, 14.513, 18.359, 1.1922, 375, 0.00634495],
    [2400, 17.730, 23.049, 1.1822, 352, 0.00673800],
]


def synthetic(N=150e6, m=0.4, swc=0.20, cw=3e-6, cf=5e-6, n=9, pressures=None):
    """Exact gas-cap reservoir data built from the MBE itself: the analysis must give back N and m."""
    pi, T = 3000.0, 640.0

    def z(p):
        return 0.80 + 0.06 * (p / 3000.0 - 0.5) ** 2 + 0.02 * (1 - p / 3000.0)

    def bg(p):
        return 0.00504 * z(p) * T / p  # rb/SCF

    def rs(p):
        return 600.0 - 0.19 * (pi - p) - 1.5e-5 * (pi - p) ** 2

    def bo(p):
        return 1.30 - 1.1e-4 * (pi - p) - 6e-9 * (pi - p) ** 2

    boi, bgi, rsi = bo(pi), bg(pi), rs(pi)
    rows = [[pi, 0.0, 0.0, boi, rsi, bgi]]
    if pressures is None:
        pressures = [pi - 160.0 * k - 6.0 * k * k for k in range(1, n)]
    for k, p in enumerate(pressures, start=1):
        Bo, Rs, Bg = bo(p), rs(p), bg(p)
        dp = pi - p
        eo = (Bo - boi) + (rsi - Rs) * Bg
        eg = boi * (Bg / bgi - 1)
        efw = boi * (cw * swc + cf) * dp / (1 - swc)
        F = N * (eo + m * eg + (1 + m) * efw)
        Np = N * (6e-5 * dp + 1e-8 * dp * dp)
        Rp = (F / Np - Bo) / Bg + Rs
        assert Rp > Rs, "synthetic data: Rp must exceed Rs (p=%g)" % p
        rows.append([p, Np / 1e6, Rp * Np / 1e6, Bo, Rs, Bg])
    params = dict(pi=pi, Boi=boi, Bgi=bgi, Rsi=rsi, Swc=swc, Cw=cw, Cf=cf)
    return rows, params


# ---------------------------------------------------------------- helpers

def style_header(ws, row, ncols):
    for c in range(1, ncols + 1):
        cell = ws.cell(row=row, column=c)
        cell.font = BOLD
        cell.fill = HEAD_FILL
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)


def autosize(ws, widths=None):
    for i, col in enumerate(ws.columns, start=1):
        w = widths[i - 1] if widths and i - 1 < len(widths) else max(10, max(len(str(c.value or "")) for c in col) + 2)
        ws.column_dimensions[get_column_letter(i)].width = w


def write_table(ws, header, rows, start_row=1, start_col=1):
    for j, h in enumerate(header):
        ws.cell(row=start_row, column=start_col + j, value=h)
    style_header(ws, start_row, start_col + len(header) - 1)
    for i, r in enumerate(rows, start=1):
        for j, v in enumerate(r):
            ws.cell(row=start_row + i, column=start_col + j, value=v)


def write_params(ws, params, start_row=1, start_col=1, header=("Property", "Value", "Unit")):
    if header:
        for j, h in enumerate(header):
            ws.cell(row=start_row, column=start_col + j, value=h)
            c = ws.cell(row=start_row, column=start_col + j)
            c.font = BOLD
            c.fill = HEAD_FILL
        start_row += 1
    for i, (label, value, unit) in enumerate(params):
        ws.cell(row=start_row + i, column=start_col, value=label)
        ws.cell(row=start_row + i, column=start_col + 1, value=value)
        if unit is not None:
            ws.cell(row=start_row + i, column=start_col + 2, value=unit)


def save(wb, *parts):
    path = os.path.join(*parts)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    wb.save(path)
    return path


def two_sheet_book(header, rows, params, prod_name="Production", init_name="Initial"):
    wb = Workbook()
    ws = wb.active
    ws.title = prod_name
    write_table(ws, header, rows)
    autosize(ws, [14] * len(header))
    ws.freeze_panes = "A2"
    ws2 = wb.create_sheet(init_name)
    write_params(ws2, params)
    autosize(ws2, [32, 14, 12])
    return wb


# ---------------------------------------------------------------- samples

def make_samples():
    os.makedirs(SAMPLES, exist_ok=True)

    # 1. Example data set (the one the dashboard opens with)
    header = [h.replace("Bg (rb/STB)", "Bg (rb/SCF)") for h in Q2_HEADER]
    wb = two_sheet_book(header, Q2_ROWS, Q2_PARAMS)
    save(wb, SAMPLES, "havlena-odeh-example.xlsx")

    # 2. Blank template
    wb = Workbook()
    ws = wb.active
    ws.title = "Production"
    write_table(ws, ["p (psia)", "Np (MMSTB)", "Gp (MMSCF)", "Bo (rb/STB)", "Rs (SCF/STB)", "Bg (rb/SCF)"], [])
    autosize(ws, [14] * 6)
    ws.freeze_panes = "A2"
    ws2 = wb.create_sheet("Initial")
    write_params(ws2, [(l, None, u) for (l, _, u) in Q2_PARAMS[:7]])
    autosize(ws2, [32, 14, 12])
    save(wb, SAMPLES, "havlena-odeh-template.xlsx")

    # 3. Second example (gas-cap reservoir, Bg in ft3/SCF, Gp in MMMSCF, no Swc/Cw/Cf)
    wb = Workbook()
    ws = wb.active
    ws.title = "Production"
    write_table(ws, Q1_HEADER, Q1_ROWS)
    autosize(ws, [16] * 6)
    save(wb, SAMPLES, "havlena-odeh-example-2.xlsx")

    # 4. Known-answer check: exact synthetic data, N = 150 MMSTB, m = 0.40
    rows, p = synthetic()
    rows = [[round(r[0], 1), round(r[1], 6), round(r[2], 6), round(r[3], 7), round(r[4], 4), float("%.7g" % r[5])] for r in rows]
    params = [
        ("Initial pressure, pi", p["pi"], "psia"),
        ("Initial oil FVF, Boi", round(p["Boi"], 7), "rb/STB"),
        ("Initial gas FVF, Bgi", float("%.7g" % p["Bgi"]), "rb/SCF"),
        ("Initial solution GOR, Rsi", round(p["Rsi"], 4), "SCF/STB"),
        ("Connate water saturation, Swc", p["Swc"], "fraction"),
        ("Water compressibility, Cw", p["Cw"], "1/psi"),
        ("Formation compressibility, Cf", p["Cf"], "1/psi"),
    ]
    wb = two_sheet_book(["p (psia)", "Np (MMSTB)", "Gp (MMSCF)", "Bo (rb/STB)", "Rs (SCF/STB)", "Bg (rb/SCF)"], rows, params)
    ws = wb["Initial"]
    ws.cell(row=11, column=1, value="Built from the material balance with N = 150 MMSTB and m = 0.40, so the analysis should return these values.")
    save(wb, SAMPLES, "known_answer_N150_m040.xlsx")


# ---------------------------------------------------------------- fixtures

def make_fixtures():
    if os.path.isdir(FIX):
        shutil.rmtree(FIX)
    os.makedirs(FIX)

    # two sheets, exactly like the sample
    save(two_sheet_book(Q2_HEADER, Q2_ROWS, Q2_PARAMS), FIX, "q2_two_sheets.xlsx")

    # params block below the table on the same sheet (handout layout: only pi, phi, Swc, Cf, Cw)
    wb = Workbook()
    ws = wb.active
    ws.title = "Data"
    ws.cell(row=1, column=1, value="Production data:")
    write_table(ws, Q2_HEADER, Q2_ROWS, start_row=2)
    ws.cell(row=15, column=1, value="Additional data:")
    write_params(ws, [("Initial Pressure", "2740 psia", None), ("Porosity", 0.25, None), ("Swc", 0.05, None),
                      ("Cf", "4.00E−06 psi⁻¹", None), ("Cw", "3.00E−06 psi⁻¹", None)], start_row=16, start_col=2, header=("Property", "Value"))
    save(wb, FIX, "q2_params_below_handout.xlsx")

    # params block to the right of the table
    wb = Workbook()
    ws = wb.active
    ws.title = "Sheet1"
    write_table(ws, Q2_HEADER, Q2_ROWS)
    write_params(ws, Q2_PARAMS, start_row=1, start_col=9)
    save(wb, FIX, "q2_params_right.xlsx")

    # title row, blank row, names row, units row
    wb = Workbook()
    ws = wb.active
    ws.title = "Field data"
    ws.cell(row=1, column=1, value="Reservoir X – production history")
    names = ["Pressure", "Rs", "Bo", "Bg", "Np", "Gp"]
    units = ["psia", "SCF/STB", "rb/STB", "rb/SCF", "MMSTB", "MMSCF"]
    for j, (n, u) in enumerate(zip(names, units), start=1):
        ws.cell(row=3, column=j, value=n)
        ws.cell(row=4, column=j, value=u)
    for i, r in enumerate(Q2_ROWS, start=5):
        for j, v in enumerate(r, start=1):
            ws.cell(row=i, column=j, value=v)
    ws2 = wb.create_sheet("Reservoir parameters")
    write_params(ws2, Q2_PARAMS)
    save(wb, FIX, "q2_title_units_row.xlsx")

    # shuffled columns, long header names, an extra unused column
    order = [4, 0, 5, 2, 1, 3]
    long_names = {0: "Average Reservoir Pressure (psia)", 1: "Solution Gas-Oil Ratio (scf/STB)", 2: "Oil Formation Volume Factor (bbl/STB)",
                  3: "Gas Formation Volume Factor (bbl/scf)", 4: "Cumulative Oil Produced (MMSTB)", 5: "Cumulative Gas Produced (MMscf)"}
    wb = Workbook()
    ws = wb.active
    ws.title = "History"
    header = ["Date"] + [long_names[k] for k in order]
    rows = [["2015-%02d" % (i + 1)] + [r[k] for k in order] for i, r in enumerate(Q2_ROWS)]
    write_table(ws, header, rows)
    ws2 = wb.create_sheet("PVT and rock")
    write_params(ws2, Q2_PARAMS)
    save(wb, FIX, "q2_shuffled_long_headers.xlsx")

    # Rp column instead of Gp
    wb = Workbook()
    ws = wb.active
    ws.title = "Production"
    header = ["p (psia)", "Np (MMSTB)", "Rp (SCF/STB)", "Bo (rb/STB)", "Rs (SCF/STB)", "Bg (rb/SCF)"]
    rows = []
    for r in Q2_ROWS:
        p, rs, bo, bg, np_, gp = r
        rp = (gp / np_) if np_ else 0
        rows.append([p, np_, rp, bo, rs, bg])
    write_table(ws, header, rows)
    ws2 = wb.create_sheet("Initial")
    write_params(ws2, Q2_PARAMS)
    save(wb, FIX, "q2_rp_column.xlsx")

    # Boi, Bgi, Rsi left out: they come from the row at pi
    wb = two_sheet_book(Q2_HEADER, Q2_ROWS, [x for x in Q2_PARAMS if not x[0].startswith(("Initial oil", "Initial gas", "Initial solution"))])
    save(wb, FIX, "q2_no_boi_bgi_rsi.xlsx")

    # numbers stored as text, unicode minus, thousands separators, units inside cells
    wb = Workbook()
    ws = wb.active
    ws.title = "Production"
    write_table(ws, ["p", "Rs", "Bo", "Bg (rb/scf)", "Np (MMSTB)", "Gp (MMSCF)"],
                [["{:,} psia".format(r[0]), str(r[1]), "%.3f" % r[2], "%.4f" % r[3], "%.2f" % r[4], "{:,}".format(r[5])] for r in Q2_ROWS])
    ws2 = wb.create_sheet("Initial")
    write_params(ws2, [("pi", "2,740 psia", None), ("Boi", "1.404 rb/STB", None), ("Bgi", "9.0E−04", "rb/SCF"),
                       ("Rsi", "650 scf/STB", None), ("Swc", "5%", None), ("Cw", "3.00E−06 psi⁻¹", None), ("Cf", "4 × 10⁻⁶ psi⁻¹", None)], header=None)
    save(wb, FIX, "q2_text_numbers_unicode.xlsx")

    # Swc in percent, compressibility in microsips
    wb = two_sheet_book(Q2_HEADER, Q2_ROWS, [
        ("pi (psia)", 2740, None), ("Boi (rb/STB)", 1.404, None), ("Bgi (rb/SCF)", 0.0009, None), ("Rsi (SCF/STB)", 650, None),
        ("Swc (%)", 5, None), ("Cw (10^-6 1/psi)", 3, None), ("Cf (10^-6 1/psi)", 4, None)], init_name="Inputs")
    save(wb, FIX, "q2_percent_microsips.xlsx")

    # rows in random order
    rnd = random.Random(7)
    rows = Q2_ROWS[:]
    rnd.shuffle(rows)
    save(two_sheet_book(Q2_HEADER, rows, Q2_PARAMS), FIX, "q2_unsorted_rows.xlsx")

    # horizontal parameter table: labels, units, values on three rows
    wb = Workbook()
    ws = wb.active
    ws.title = "Production"
    write_table(ws, Q2_HEADER, Q2_ROWS)
    ws2 = wb.create_sheet("Initial")
    labels = ["pi", "Boi", "Bgi", "Rsi", "Swc", "Cw", "Cf"]
    units = ["psia", "rb/STB", "rb/SCF", "SCF/STB", "fraction", "1/psi", "1/psi"]
    values = [2740, 1.404, 0.0009, 650, 0.05, 3e-6, 4e-6]
    for j in range(7):
        ws2.cell(row=1, column=j + 1, value=labels[j])
        ws2.cell(row=2, column=j + 1, value=units[j])
        ws2.cell(row=3, column=j + 1, value=values[j])
    save(wb, FIX, "q2_horizontal_params.xlsx")

    # parameters written inside single cells: "pi = 2740 psia"
    wb = Workbook()
    ws = wb.active
    ws.title = "Production"
    write_table(ws, Q2_HEADER, Q2_ROWS)
    for i, t in enumerate(["pi = 2740 psia", "Boi = 1.404 rb/STB", "Bgi = 0.0009 rb/SCF", "Rsi = 650 SCF/STB",
                           "Swc: 0.05", "Cw = 3e-6 1/psi", "Cf = 4e-6 1/psi"], start=15):
        ws.cell(row=i, column=1, value=t)
    save(wb, FIX, "q2_inline_params.xlsx")

    # Bg in ft3/SCF without a unit in the header (unit is inferred), pi given; Bgi given in ft3/SCF with unit
    wb = Workbook()
    ws = wb.active
    ws.title = "Production"
    write_table(ws, ["p", "Np", "Gp", "Bo", "Rs", "Bg"],
                [[r[0], r[4] * 1e6, r[5] * 1e6, r[2], r[1], r[3] * 5.615] for r in Q2_ROWS])
    ws2 = wb.create_sheet("Initial")
    write_params(ws2, [("pi", 2740, "psia"), ("Boi", 1.404, "rb/STB"), ("Bgi", 0.0009 * 5.615, "ft3/SCF"), ("Rsi", 650, "SCF/STB"),
                       ("Swc", 0.05, ""), ("Cw", 3e-6, "1/psi"), ("Cf", 4e-6, "1/psi")])
    save(wb, FIX, "q2_no_units_field.xlsx")

    # SI units: bar, Sm3, Sm3/Sm3, rm3/Sm3 (same reservoir as the example)
    wb = Workbook()
    ws = wb.active
    ws.title = "Production"
    write_table(ws, ["p (bar)", "Np (Sm3)", "Gp (Sm3)", "Bo (rm3/Sm3)", "Rs (Sm3/Sm3)", "Bg (rm3/Sm3)"],
                [[r[0] / 14.5038, r[4] * 1e6 / 6.28981, r[5] * 1e6 / 35.3147, r[2], r[1] / 5.6146, r[3] * 5.615] for r in Q2_ROWS])
    ws2 = wb.create_sheet("Initial")
    write_params(ws2, [("pi", 2740 / 14.5038, "bar"), ("Boi", 1.404, "rm3/Sm3"), ("Bgi", 0.0009 * 5.615, "rm3/Sm3"),
                       ("Rsi", 650 / 5.6146, "Sm3/Sm3"), ("Swc", 0.05, "fraction"), ("Cw", 3e-6 * 14.5038, "1/bar"), ("Cf", 4e-6 * 14.5038, "1/bar")])
    save(wb, FIX, "q2_si_units.xlsx")

    # Q1 in the handout layout: "Pressure" sits on the units row (two-row header)
    wb = Workbook()
    ws = wb.active
    ws.title = "Q1"
    for j, h in enumerate(["", "Np", "Gp", "Bo", "Rs", "Bg"], start=1):
        ws.cell(row=1, column=j, value=h or None)
    for j, h in enumerate(["Pressure", "(MMSTB)", "(MMMSCF)", "(bbl/STB)", "(SCF/STB)", "(cuft/SCF)"], start=1):
        ws.cell(row=2, column=j, value=h)
    for i, r in enumerate(Q1_ROWS, start=3):
        for j, v in enumerate(r, start=1):
            ws.cell(row=i, column=j, value=v)
    save(wb, FIX, "q1_two_row_header.xlsx")

    # Q1 with single-row headers
    wb = Workbook()
    ws = wb.active
    write_table(ws, Q1_HEADER, Q1_ROWS)
    save(wb, FIX, "q1_simple.xlsx")

    # exact synthetic data with water production and a Wp/Bw column
    rows, p = synthetic(N=80e6, m=0.25, swc=0.25, cw=3.5e-6, cf=6e-6, n=12)
    wb = Workbook()
    ws = wb.active
    ws.title = "Production"
    write_table(ws, ["p (psia)", "Np (MMSTB)", "Gp (MMSCF)", "Bo (rb/STB)", "Rs (SCF/STB)", "Bg (rb/SCF)"], rows)
    ws2 = wb.create_sheet("Initial")
    write_params(ws2, [("pi", p["pi"], "psia"), ("Boi", p["Boi"], "rb/STB"), ("Bgi", p["Bgi"], "rb/SCF"), ("Rsi", p["Rsi"], "SCF/STB"),
                       ("Swc", p["Swc"], ""), ("Cw", p["Cw"], "1/psi"), ("Cf", p["Cf"], "1/psi")])
    save(wb, FIX, "synthetic_N80_m025.xlsx")

    # large file: 400 rows
    rows, p = synthetic(N=250e6, m=0.6, swc=0.18, cw=3e-6, cf=4e-6, pressures=[3000.0 - 6.0 * k for k in range(1, 400)])
    wb = Workbook()
    ws = wb.active
    ws.title = "Production"
    write_table(ws, ["p (psia)", "Np (MMSTB)", "Gp (MMSCF)", "Bo (rb/STB)", "Rs (SCF/STB)", "Bg (rb/SCF)"], rows)
    ws2 = wb.create_sheet("Initial")
    write_params(ws2, [("pi", p["pi"], "psia"), ("Boi", p["Boi"], "rb/STB"), ("Bgi", p["Bgi"], "rb/SCF"), ("Rsi", p["Rsi"], "SCF/STB"),
                       ("Swc", p["Swc"], ""), ("Cw", p["Cw"], "1/psi"), ("Cf", p["Cf"], "1/psi")])
    save(wb, FIX, "synthetic_large.xlsx")

    # ---- error cases
    wb = Workbook()
    ws = wb.active
    ws.title = "Notes"
    ws["A1"] = "Nothing useful here"
    ws["B3"] = 42
    save(wb, FIX, "err_no_table.xlsx")

    wb = Workbook()
    ws = wb.active
    write_table(ws, ["p (psia)", "Np (MMSTB)", "Gp (MMSCF)", "Bo (rb/STB)", "Rs (SCF/STB)"], [r[:1] + [r[4], r[5], r[2], r[1]] for r in Q2_ROWS])
    save(wb, FIX, "err_missing_bg.xlsx")

    wb = Workbook()
    save(wb, FIX, "err_empty.xlsx")

    wb = Workbook()
    ws = wb.active
    write_table(ws, Q2_HEADER, Q2_ROWS[:2])
    save(wb, FIX, "err_one_point.xlsx")

    with open(os.path.join(FIX, "err_not_a_workbook.xlsx"), "wb") as f:
        f.write(b"PK\x03\x04 this is not really a zip file")

    # ---- CSV versions
    with open(os.path.join(FIX, "q2_comma.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(Q2_HEADER)
        w.writerows(Q2_ROWS)
        w.writerow([])
        for label, value, unit in Q2_PARAMS:
            w.writerow([label, value, unit])
    with open(os.path.join(FIX, "q2_semicolon_decimal_comma.csv"), "w", newline="", encoding="utf-8-sig") as f:
        f.write(";".join(Q2_HEADER) + "\n")
        for r in Q2_ROWS:
            f.write(";".join(str(v).replace(".", ",") for v in r) + "\n")
        f.write("\n")
        for label, value, unit in Q2_PARAMS:
            f.write("%s;%s;%s\n" % (label, ("%g" % value).replace(".", ","), unit))

    # ---- LibreOffice conversions
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    if soffice:
        src = os.path.join(FIX, "q2_two_sheets.xlsx")
        tmp = tempfile.mkdtemp()
        for fmt, name in (("xls", "q2_legacy.xls"), ("ods", "q2_open_document.ods")):
            subprocess.run([soffice, "--headless", "--convert-to", fmt, "--outdir", tmp, src], check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)
            shutil.move(os.path.join(tmp, "q2_two_sheets." + fmt), os.path.join(FIX, name))
        # LibreOffice re-save of the xlsx (shared strings, different XML style)
        subprocess.run([soffice, "--headless", "--convert-to", "xlsx:Calc MS Excel 2007 XML", "--outdir", tmp,
                        os.path.join(FIX, "q2_params_below_handout.xlsx")], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)
        shutil.move(os.path.join(tmp, "q2_params_below_handout.xlsx"), os.path.join(FIX, "q2_libreoffice_saved.xlsx"))
        shutil.rmtree(tmp, ignore_errors=True)
    else:
        print("soffice not found: .xls/.ods fixtures skipped")


if __name__ == "__main__":
    make_samples()
    make_fixtures()
    print("samples:", sorted(os.listdir(SAMPLES)))
    print("fixtures:", sorted(os.listdir(FIX)))
