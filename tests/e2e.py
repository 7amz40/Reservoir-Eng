"""
End-to-end tests of the dashboard in a real browser (Chromium through Playwright).

    python3 tests/e2e.py              # run all checks
    python3 tests/e2e.py --shots DIR  # also save screenshots to DIR

Needs: pip install playwright openpyxl && python -m playwright install chromium
The page is opened from disk (file://), the same way a user opens index.html.
Web fonts are blocked so the test does not depend on the network.
"""
import base64
import io
import os
import re
import sys
import tempfile
import time
import traceback

from openpyxl import Workbook, load_workbook
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIX = os.path.join(ROOT, "tests", "fixtures")
SAMPLES = os.path.join(ROOT, "samples")
URL = "file://" + os.path.join(ROOT, "index.html")

SHOTS = None
if "--shots" in sys.argv:
    SHOTS = sys.argv[sys.argv.index("--shots") + 1]
    os.makedirs(SHOTS, exist_ok=True)

results = []


def check(name):
    def deco(fn):
        results.append((name, fn))
        return fn
    return deco


# ------------------------------------------------------------------ helpers

class Page:
    def __init__(self, browser, width=1440, height=900, scheme="light"):
        self.ctx = browser.new_context(viewport={"width": width, "height": height}, color_scheme=scheme, accept_downloads=True)
        self.page = self.ctx.new_page()
        self.errors = []
        self.page.on("pageerror", lambda e: self.errors.append("pageerror: %s" % e))
        self.page.on("console", lambda m: self.errors.append("console: " + m.text) if m.type == "error" and "fonts.g" not in m.text and "ERR_" not in m.text else None)
        self.page.route("**/fonts.googleapis.com/**", lambda r: r.abort())
        self.page.route("**/fonts.gstatic.com/**", lambda r: r.abort())
        self.page.goto(URL)
        self.page.wait_for_function("window.HOApp && window.HOApp.bundle()")

    def text(self, sel):
        return self.page.locator(sel).inner_text().strip()

    def val(self, rid):
        return self.text("#%s .val" % rid)

    def upload(self, path):
        self.page.set_input_files("#file", path)
        name = os.path.basename(path)
        self.page.wait_for_function("(n) => document.querySelector('#source').textContent.includes(n) || !document.querySelector('#alert').hidden", arg=name)
        self.page.wait_for_timeout(150)

    def unfold(self, *ids):
        """Open sidebar sections by their headings (Reservoir parameters and Columns and units start folded)."""
        for i in ids:
            if not self.page.evaluate("(id) => document.getElementById(id).open", i):
                self.page.click("#%s > summary" % i)

    def is_open(self, sid):
        return self.page.evaluate("(id) => document.getElementById(id).open", sid)

    def model(self):
        """The model the dashboard chose from the data: family, aquifer, water, U, reD."""
        return self.page.evaluate("""() => { const b = HOApp.bundle(), c = b && b.model;
            return c ? { family: c.family, aquifer: c.water ? c.aquifer : null, water: !!c.water, U: c.fit.U, reD: c.reD === Infinity ? 'inf' : c.reD } : null; }""")

    def title(self):
        """The drive mechanism found from the data (named in the exported results)."""
        return self.page.evaluate("() => { const b = HOApp.bundle(); return b && b.model ? HODrive.NAMES[b.model.family] : ''; }")

    def fit_points(self):
        m = re.search(r"from (\d+) point", self.text("#fitline"))
        return int(m.group(1)) if m else None

    def close(self):
        assert not self.errors, "browser errors: %s" % self.errors
        self.ctx.close()


def num(s):
    return float(s.replace("−", "-").replace(",", ""))


def approx(a, b, rel=1e-3):
    assert abs(a - b) <= abs(b) * rel + 1e-12, "%r is not close to %r" % (a, b)


def shot(pg, name, full=False):
    if SHOTS:
        pg.page.screenshot(path=os.path.join(SHOTS, name + ".png"), full_page=full)


# ------------------------------------------------------------------ checks

@check("opens with the example data and its answer")
def t_example(b):
    pg = Page(b)
    assert pg.page.locator("#alert").is_hidden()
    # the Q1 data: a gas-cap reservoir, found from the data
    assert pg.title() == "Gas-cap drive"
    assert pg.is_open("sec-data") and not pg.is_open("sec-params") and not pg.is_open("sec-cols"), "only Data source starts open"
    assert pg.page.locator("#verdict, #evidence, #shares").count() == 0, "no verdict box"
    assert pg.page.locator("#sec-drive, input[name=mech], #aq-box").count() == 0, "no drive mechanism settings"
    assert pg.page.locator("#panel-diag, #models, #chart-app").count() == 0, "no models panel on the page"
    assert pg.val("res-N") == "108.6" and pg.val("res-m") == "0.542" and pg.val("res-G") == "84.62"
    assert pg.page.locator("#res-We").is_hidden()
    assert "rounding the table" in pg.text("#res-N .res-ci")
    # oil recovered so far: 17.73 of 108.6 MMSTB at 2,400 psia
    assert pg.val("res-RF") == "16.3" and pg.text("#res-RF .u") == "%"
    assert "at 2,400 psia" in pg.text("#res-RF-how")
    assert pg.text("#res-RF .res-ci") == "17.73 of 108.6 MMSTB produced; 90.92 MMSTB remain", pg.text("#res-RF .res-ci")
    assert pg.page.locator("#chart-ho circle.hit").count() == 6 and pg.fit_points() == 6
    assert pg.page.locator("#calc tbody tr").count() == 7
    assert "Example" in pg.text("#source")
    # initial values from the second sheet; S_wc, C_w and C_f are not given, so E_fw = 0 and the line is F/Eo against Eg/Eo
    pg.unfold("sec-params")
    assert pg.text("#src-pi").endswith("Initial!B2") and pg.text("#src-Bgi").endswith("Initial!B4")
    assert pg.text("#src-Swc").startswith("Not in the file")
    axes = lambda: pg.page.locator("#chart-ho svg").text_content()
    assert "Eg / Eo" in axes() and "F / Eo, MMSTB" in axes(), axes()
    assert "Efw = 0" in pg.text("#notes")
    shot(pg, "desktop-light", full=True)
    # typing S_wc, C_w and C_f brings E_fw in
    for k, v in (("Swc", "0.2"), ("Cw", "3e-6"), ("Cf", "5e-6")):
        pg.page.fill("#prm-" + k, v)
        pg.page.press("#prm-" + k, "Enter")
    assert "Eg / [Eo + (1 + m) Efw]" in axes(), axes()
    assert pg.val("res-N") != "108.6" and pg.title() == "Gas-cap drive"
    for k in ("Swc", "Cw", "Cf"):
        pg.page.click("#src-%s .reset" % k)
    assert pg.val("res-N") == "108.6"
    pg.close()


@check("Q2 data: water drive found, with the rows taken as equal time steps")
def t_q2(b):
    pg = Page(b)
    pg.upload(os.path.join(FIX, "q2_example.xlsx"))
    assert pg.page.locator("#alert").is_hidden()
    # found from the data: water drive (Dake's exercise 9.2) with an unsteady-state aquifer
    assert pg.title() == "Water drive" and pg.model()["aquifer"] == "veh", pg.model()
    assert "equal time steps" in pg.text("#notes"), "the assumption is said"
    assert pg.val("res-N") == "286.6" and pg.val("res-m") == "0.000" and pg.val("res-G") == "0"
    assert pg.page.locator("#res-We").is_visible() and pg.val("res-We") == "96.95"
    assert "rounding the table" in pg.text("#res-N .res-ci")
    assert "slope 1" in pg.page.locator("#chart-ho svg").text_content()
    assert pg.page.locator("#chart-ho circle.hit").count() == 10 and pg.fit_points() == 10
    assert pg.page.locator("#calc tbody tr").count() == 11
    assert pg.page.locator("#chart-drive svg").count() == 1 and "Water influx" in pg.text("#legend-drive")
    shot(pg, "desktop-q2", full=True)
    pg.close()


@check("every layout of the Q2 data gives the same answer")
def t_layouts(b):
    pg = Page(b)
    for f in sorted(os.listdir(FIX)):
        if not f.startswith("q2_") or f.endswith((".xls", ".ods")):
            continue
        pg.upload(os.path.join(FIX, f))
        assert pg.page.locator("#alert").is_hidden(), f + ": " + pg.text("#alert")
        assert pg.title() == "Water drive", f + ": " + pg.title()
        # one layout has monthly dates: real steps of 28 to 31 days instead of equal steps, so its aquifer fit differs
        # (N stays inside the rounding range of the Q2 data, 246 to 330 MMSTB)
        if "shuffled_long_headers" in f:
            assert 246 <= num(pg.val("res-N")) <= 330, f + " N=" + pg.val("res-N")
        else:
            assert pg.val("res-N") == "286.6", f + " N=" + pg.val("res-N")
        assert pg.fit_points() == 10, f
    pg.close()


@check("Q1 in the handout layout, known-answer sample and a 400-row file")
def t_other_data(b):
    pg = Page(b)
    pg.upload(os.path.join(FIX, "q1_two_row_header.xlsx"))
    assert pg.title() == "Gas-cap drive"
    assert pg.val("res-N") == "108.6" and pg.val("res-m") == "0.542" and pg.val("res-G") == "84.62"
    assert "E" in pg.text("#notes") and "neglected" in pg.text("#notes")
    shot(pg, "desktop-q1")
    pg.upload(os.path.join(SAMPLES, "known_answer_N150_m040.xlsx"))
    assert pg.title() == "Gas-cap drive"
    assert pg.val("res-N") == "150.0" and pg.val("res-m") == "0.400"
    t0 = time.time()
    pg.upload(os.path.join(FIX, "synthetic_large.xlsx"))
    assert time.time() - t0 < 5
    assert pg.val("res-N") == "250.0" and pg.val("res-m") == "0.600"
    assert pg.page.locator("#calc tbody tr").count() == 30
    pg.page.click("#table-more")
    assert pg.page.locator("#calc tbody tr").count() == 400
    pg.close()


@check("files that cannot be read show a clear message and keep the last result")
def t_errors(b):
    pg = Page(b)
    pg.upload(os.path.join(FIX, "q2_legacy.xls"))
    assert "97–2003" in pg.text("#alert")
    assert pg.val("res-N") == "108.6", "previous result kept"
    pg.page.click("#alert button[data-act=dismiss]")
    assert pg.page.locator("#alert").is_hidden()
    pg.upload(os.path.join(FIX, "q2_open_document.ods"))
    assert "OpenDocument" in pg.text("#alert")
    pg.upload(os.path.join(FIX, "err_not_a_workbook.xlsx"))
    assert "could not be opened" in pg.text("#alert")
    pg.upload(os.path.join(FIX, "err_missing_bg.xlsx"))
    assert "Missing column" in pg.text("#alert")
    assert pg.val("res-N") == "–"
    assert pg.is_open("sec-cols") and not pg.is_open("sec-params"), "Columns and units opens to pick the column"
    shot(pg, "desktop-error")
    pg.upload(os.path.join(FIX, "err_no_table.xlsx"))
    assert "No production table" in pg.text("#alert")
    pg.upload(os.path.join(SAMPLES, "havlena-odeh-template.xlsx"))
    assert "no rows with numbers" in pg.text("#alert")
    pg.page.click("#alert button[data-act=example]")
    assert pg.val("res-N") == "108.6"
    pg.close()
    # a file without B_oi, B_gi and R_si opens Reservoir parameters, where they can be typed
    pg = Page(b)
    wb = Workbook()
    ws = wb.active
    ws.title = "Production"
    for r in [["p (psia)", "Np (MMSTB)", "Gp (MMMSCF)", "Bo (bbl/STB)", "Rs (SCF/STB)", "Bg (cuft/SCF)"],
              [3150, 3.295, 3.460, 1.2353, 477, 0.0051658], [3000, 5.903, 6.257, 1.2222, 450, 0.0053904],
              [2850, 8.852, 10.268, 1.2122, 425, 0.00567115], [2700, 11.503, 14.206, 1.2022, 401, 0.00600805]]:
        ws.append(r)
    ws2 = wb.create_sheet("Initial")
    ws2.append(["Property", "Value", "Unit"])
    ws2.append(["Initial pressure, pi", 3300, "psia"])
    path = os.path.join(tempfile.mkdtemp(), "no_initial_fvf.xlsx")
    wb.save(path)
    pg.upload(path)
    assert pg.is_open("sec-params") and not pg.is_open("sec-cols"), "Reservoir parameters opens to type the missing values"
    assert "is missing" in pg.text("#notes") and pg.text("#src-Boi").startswith("Missing")
    pg.close()


@check("points can be left out from the table, the plot and the keyboard")
def t_exclude(b):
    pg = Page(b)
    pg.page.uncheck("#calc tbody tr:nth-child(2) input[type=checkbox]")
    assert pg.fit_points() == 5
    assert pg.page.locator("#reset-points").is_visible()
    assert pg.val("res-N") != "108.6"
    pg.page.click("#reset-points")
    assert pg.fit_points() == 6 and pg.val("res-N") == "108.6"
    pg.page.locator("#chart-ho circle.hit").first.focus()
    pg.page.keyboard.press("Enter")
    assert pg.fit_points() == 5
    assert pg.page.evaluate("document.activeElement.classList.contains('hit')"), "focus stays on the point"
    pg.page.keyboard.press("Enter")
    assert pg.fit_points() == 6
    pg.page.locator("#chart-ho circle.hit").nth(0).click()
    assert pg.fit_points() == 5
    pg.close()


@check("parameters, E_fw switch, columns and units drive the answer")
def t_inputs(b):
    pg = Page(b)
    # built with N = 150 MMSTB and m = 0.40, with S_wc = 0.2, C_w = 3e-6 and C_f = 5e-6
    pg.upload(os.path.join(SAMPLES, "known_answer_N150_m040.xlsx"))
    assert pg.title() == "Gas-cap drive" and pg.val("res-N") == "150.0" and pg.val("res-m") == "0.400"
    pg.unfold("sec-params", "sec-cols")
    axes = lambda: pg.page.locator("#chart-ho svg").text_content()
    assert "Eg / [Eo + (1 + m) Efw]" in axes() and "F / [Eo + (1 + m) Efw], MMSTB" in axes(), axes()
    pg.page.uncheck("#efw")
    # without E_fw, the rock and connate-water expansion (it grows with the pressure drop, as a pot aquifer does)
    # is taken up by a pot aquifer of K = N (1 + m) Boi (Cw Swc + Cf) / (1 - Swc) = 1,911 rb/psi, and N stays 150
    model = pg.model()
    assert pg.title() == "Combination drive: gas cap and water" and model["aquifer"] == "pot", model
    approx(model["U"], 150e6 * 1.4 * 1.3 * (3e-6 * 0.2 + 5e-6) / 0.8, 1e-3)
    assert pg.val("res-N") == "150.0" and pg.page.locator("#res-We").is_visible()
    assert "Eg / Eo" in axes() and "(F − We) / Eo, MMSTB" in axes(), axes()
    pg.page.check("#efw")
    assert pg.title() == "Gas-cap drive" and pg.val("res-N") == "150.0" and pg.page.locator("#res-We").is_hidden()
    for k in ("Swc", "Cw", "Cf"):
        pg.page.fill("#prm-" + k, "0")
        pg.page.press("#prm-" + k, "Enter")
    assert pg.title() == "Combination drive: gas cap and water", "zero S_wc, C_w and C_f is the same as leaving E_fw out"
    assert pg.text("#src-Cf").startswith("Your value")
    for k in ("Cf", "Cw", "Swc"):
        pg.page.click("#src-%s .reset" % k)
    assert pg.val("res-N") == "150.0"
    pg.page.fill("#prm-Boi", "abc")
    pg.page.press("#prm-Boi", "Enter")
    assert pg.page.get_attribute("#prm-Boi", "aria-invalid") == "true"
    pg.page.fill("#prm-Boi", "1.3")
    pg.page.press("#prm-Boi", "Enter")
    # compressibility typed with a unit
    pg.page.fill("#prm-Cf", "5 x 10-6 1/psi")
    pg.page.press("#prm-Cf", "Enter")
    assert pg.val("res-N") == "150.0"
    # columns
    bg_col, gp_unit = pg.page.input_value("#col-Bg"), pg.page.input_value("#unit-Gp")
    pg.page.select_option("#col-Bg", "-1")
    assert "Missing column" in pg.text("#alert")
    pg.page.select_option("#col-Bg", bg_col)
    assert pg.page.locator("#alert").is_hidden() and pg.val("res-N") == "150.0"
    pg.page.select_option("#unit-Gp", "MMMSCF")
    assert gp_unit == "MMSCF" and pg.val("res-N") != "150.0"
    pg.page.select_option("#unit-Gp", gp_unit)
    assert pg.val("res-N") == "150.0"
    # result units: G = m N Boi / Bgi = 0.40 x 150e6 x 1.3 / 0.000876288 SCF = 89,012 MMSCF
    pg.page.select_option("#out-N", "STB")
    approx(num(pg.val("res-N")), 150e6, 1e-4)
    assert pg.text("#res-N .u") == "STB"
    pg.page.select_option("#out-G", "MMSCF")
    approx(num(pg.val("res-G")), 0.40 * 150e6 * 1.3 / 0.000876288 / 1e6, 1e-3)
    pg.close()


@check("m explorer: slider, number box and the scan chart")
def t_explorer(b):
    pg = Page(b)
    pg.page.fill("#m-num", "0.3")
    pg.page.press("#m-num", "Enter")
    assert "0.300" in pg.text("#m-read")
    assert pg.page.locator("#chart-exp svg").count() == 1 and pg.page.locator("#chart-scan svg").count() == 1
    pg.page.click("#m-fit")
    assert "0.542" in pg.text("#m-read")
    overlay = pg.page.locator("#chart-scan svg rect[fill=transparent]")
    overlay.scroll_into_view_if_needed()
    box = overlay.bounding_box()
    pg.page.mouse.click(box["x"] + box["width"] * 0.8, box["y"] + box["height"] / 2)
    assert "0.542" not in pg.text("#m-read").split(",")[0]
    pg.close()


@check("theme switch redraws the charts in dark colors")
def t_theme(b):
    pg = Page(b)
    paper_light = pg.page.get_attribute("#chart-ho .paper rect", "fill")
    pg.page.click("#theme-btn")
    assert pg.page.get_attribute("html", "data-theme") == "dark"
    paper_dark = pg.page.get_attribute("#chart-ho .paper rect", "fill")
    assert paper_light != paper_dark, "chart colors follow the theme"
    shot(pg, "desktop-dark")
    pg.close()


@check("downloads: template, example, results, CSV and PNG")
def t_downloads(b):
    pg = Page(b)
    tmp = tempfile.mkdtemp()

    def grab(selector):
        with pg.page.expect_download() as d:
            pg.page.click(selector)
        path = os.path.join(tmp, d.value.suggested_filename)
        d.value.save_as(path)
        return path

    p = grab("#dl-template")
    wb = load_workbook(p)
    assert wb.sheetnames == ["Production", "Initial"]
    assert wb["Production"]["A1"].value == "t (years)" and wb["Production"]["C1"].value == "Np (MMSTB)"
    p = grab("#dl-example")
    wb = load_workbook(p)
    assert wb.sheetnames == ["Production", "Initial"]
    assert wb["Production"]["A1"].value == "Pressure (psia)" and wb["Production"]["A3"].value == 3150
    assert wb["Initial"]["B2"].value == 3300 and wb["Initial"]["B6"].value is None, "S_wc is not given"
    # the example file reads back into the same answer
    pg.upload(p)
    assert pg.val("res-N") == "108.6" and pg.val("res-m") == "0.542"
    p = grab("#export-btn")
    wb = load_workbook(p)
    assert wb.sheetnames == ["Results", "Calculations", "Inputs", "Notes"]
    res = [r for r in wb["Results"].iter_rows(values_only=True) if r and r[0]]
    by = {(r[0], r[2]): r for r in res}
    assert any(r[0] == "Drive mechanism" and r[1].startswith("Gas-cap drive (found from the data)") for r in res)
    approx(by[("N, oil initially in place", "MMSTB")][1], 108.647, 1e-4)
    approx(by[("m, gas-cap to oil-zone volume ratio", "-")][1], 0.5416, 1e-3)
    approx(by[("G, gas-cap gas initially in place", "Bscf")][1], 84.619, 1e-4)
    assert by[("Np, oil produced at the last step", "STB")][1] == 17.73e6
    approx(by[("RF, oil recovered so far (Np / N)", "%")][1], 100 * 17.73 / 108.647, 1e-4)
    assert by[("We, water influx at the last step", "rb")][1] is None
    assert not any("How the mechanism" in str(r[0]) for r in res), "no list of models or evidence in the export"
    # F at 3,150 psia: Np Bo + (Gp - Np Rs) Bg = 3.295e6 x 1.2353 + (3.460e9 - 3.295e6 x 477) x 0.00092 rb
    approx(wb["Calculations"]["J3"].value, 5807535.7, 1e-6)
    p = grab("#csv-btn")
    text = open(p, encoding="utf-8-sig").read()
    assert text.startswith("t (years),p (psia),Np (STB)") and text.count("\n") == 7
    p = grab("#png-ho")
    assert open(p, "rb").read(8) == b"\x89PNG\r\n\x1a\n"
    pg.close()


def pdf_pages(data):
    return len(re.findall(rb"/Type\s*/Page(?![s\w])", data))


@check("one-page report: results, plot and inputs, printed or as a file")
def t_report(b):
    pg = Page(b)
    # laid out for print: one A4 page with the mechanism, the results, the plot and the inputs
    assert pg.page.evaluate("HOApp.report.prepare()")
    text = pg.page.locator("#report").text_content()
    for t in ("Drive mechanism: Gas-cap drive", "108.6", "0.542", "84.62", "16.3", "Initial parameters", "Production data", "3,150", "2,400"):
        assert t in text, t
    assert pg.page.locator("#report .rp-chart svg").count() == 1 and pg.page.locator("#report .rp-res").count() == 4
    assert pdf_pages(pg.page.pdf(prefer_css_page_size=True, print_background=True)) == 1
    pg.page.evaluate("HOApp.report.clear()")
    assert pg.page.locator("#report").count() == 0
    # the button prints it and tidies up after the print dialog
    pg.page.evaluate("() => { window.__ev = []; addEventListener('beforeprint', () => __ev.push('before')); addEventListener('afterprint', () => __ev.push('after')); }")
    title = pg.page.title()
    pg.page.click("#report-btn")
    pg.page.wait_for_timeout(600)
    assert pg.page.evaluate("__ev") == ["before", "after"]
    assert pg.page.locator("#report").count() == 0 and pg.page.title() == title
    # where printing is blocked (the hosted preview), the same page comes as a file to open and print
    pg.page.evaluate("window.print = () => {}")
    with pg.page.expect_download() as d:
        pg.page.click("#report-btn")
    path = os.path.join(tempfile.mkdtemp(), d.value.suggested_filename)
    d.value.save_as(path)
    assert d.value.suggested_filename == "havlena-odeh-example_report.html"
    html = open(path, encoding="utf-8").read()
    assert "Print or save as PDF" in html and "<svg" in html and "108.6" in html and "16.3" in html
    page2 = pg.page.context.new_page()
    page2.route("**/fonts.googleapis.com/**", lambda r: r.abort())
    page2.route("**/fonts.gstatic.com/**", lambda r: r.abort())
    page2.goto("file://" + path)
    assert pdf_pages(page2.pdf(prefer_css_page_size=True, print_background=True)) == 1
    page2.close()
    # in the dark theme the report keeps the light colours of paper, and the dashboard stays dark
    paper_light = pg.page.get_attribute("#chart-ho .paper rect", "fill")
    pg.page.click("#theme-btn")
    paper_dark = pg.page.get_attribute("#chart-ho .paper rect", "fill")
    assert paper_dark != paper_light
    assert pg.page.evaluate("HOApp.report.prepare()")
    assert pg.page.get_attribute("#report .rp-chart .paper rect", "fill") == paper_light
    assert pg.page.get_attribute("#chart-ho .paper rect", "fill") == paper_dark
    pg.page.evaluate("HOApp.report.clear()")
    pg.page.click("#theme-btn")
    # a longer file and one with water influx still fit one page
    for f, expect in (("synthetic_large.xlsx", "more rows"), ("q2_example.xlsx", "Water drive")):
        pg.upload(os.path.join(FIX, f))
        assert pg.page.evaluate("HOApp.report.prepare()")
        assert expect in pg.page.locator("#report").text_content(), f
        assert pdf_pages(pg.page.pdf(prefer_css_page_size=True, print_background=True)) == 1, f
        pg.page.evaluate("HOApp.report.clear()")
    pg.close()


@check("drive mechanism found without settings: W_e column and pot aquifer")
def t_drive(b):
    pg = Page(b)
    # a file with a W_e column is used straight away
    pg.upload(os.path.join(FIX, "synthetic_we_column.xlsx"))
    assert pg.title() == "Combination drive: gas cap and water", pg.title()
    assert pg.model()["aquifer"] == "column", pg.model()
    assert pg.val("res-N") == "120.0" and pg.val("res-m") == "0.300"
    assert pg.page.locator("#chart-drive svg").count() == 1
    assert "Water influx" in pg.text("#legend-drive")
    # the same reservoir without the column: the pot aquifer is found by least squares
    pg.upload(os.path.join(FIX, "synthetic_pot_aquifer.xlsx"))
    model = pg.model()
    assert pg.title() == "Combination drive: gas cap and water" and model["aquifer"] == "pot", model
    approx(model["U"], 60000, 1e-6)
    assert pg.val("res-N") == "120.0" and pg.val("res-m") == "0.300", (pg.val("res-N"), pg.val("res-m"))
    assert "(F − We)" in pg.page.locator("#chart-ho svg").text_content(), "y axis shows F − We"
    shot(pg, "desktop-influx", full=True)
    pg.close()


@check("each mechanism is found from its sample file")
def t_samples(b):
    pg = Page(b)
    # file, mechanism found, N, m, aquifer
    cases = [
        ("drive_depletion_N150.xlsx", "Depletion drive", "150.0", "0.000", None),
        ("drive_water_unsteady_N150.xlsx", "Water drive", "150.0", "0.000", "veh"),
        ("drive_gascap_water_N150_m030.xlsx", "Combination drive: gas cap and water", "150.0", "0.300", "pot"),
        ("drive_undersaturated_N150.xlsx", "Depletion drive", "150.0", "0.000", None),
        ("havlena-odeh-example.xlsx", "Gas-cap drive", "108.6", "0.542", None),
    ]
    for f, title, N, m, aq in cases:
        pg.upload(os.path.join(SAMPLES, f))
        assert pg.page.locator("#alert").is_hidden(), f + ": " + pg.text("#alert")
        assert pg.title() == title, f + ": " + pg.title()
        assert pg.val("res-N") == N and pg.val("res-m") == m, f + ": N=" + pg.val("res-N") + " m=" + pg.val("res-m")
        assert pg.model()["aquifer"] == aq, f + ": " + str(pg.model())
        assert pg.page.locator("#res-We").is_visible() == bool(aq), f + ": the W_e card shows only with water influx"
        if f == "drive_water_unsteady_N150.xlsx":
            assert "equal time steps" not in pg.text("#notes"), "the time column is used"
            assert pg.page.locator("#calc thead").inner_text().startswith("Data") and "years" in pg.page.locator("#calc thead").inner_text()
        if f == "drive_undersaturated_N150.xlsx":
            assert pg.page.locator("#panel-explorer").is_hidden()
    pg.close()


@check("drag and drop a file onto the page")
def t_drop(b):
    pg = Page(b)
    data = base64.b64encode(open(os.path.join(SAMPLES, "known_answer_N150_m040.xlsx"), "rb").read()).decode()
    pg.page.evaluate("""(b64) => {
      const bin = atob(b64), arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const file = new File([arr], 'dropped.xlsx');
      const dt = new DataTransfer(); dt.items.add(file);
      window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }""", data)
    pg.page.wait_for_function("document.querySelector('#source').textContent.includes('dropped.xlsx')")
    assert pg.val("res-N") == "150.0" and pg.val("res-m") == "0.400"
    assert pg.page.locator("#drop-overlay").is_hidden()
    pg.close()


@check("phone width: no sideways scrolling, results readable")
def t_mobile(b):
    pg = Page(b, width=390, height=844)
    assert pg.page.evaluate("document.documentElement.scrollWidth") <= 390
    assert pg.val("res-N") == "108.6"
    assert pg.title() == "Gas-cap drive"
    assert pg.page.locator("#sec-params").get_attribute("open") is None, "secondary sections start folded"
    shot(pg, "mobile", full=True)
    pg.close()


@check("keyboard: drop zone, focus order and labels")
def t_a11y(b):
    pg = Page(b)
    pg.unfold("sec-params", "sec-cols")
    unlabeled = pg.page.evaluate("""() => [...document.querySelectorAll('input:not([type=file]), select, button')]
      .filter(el => el.offsetParent !== null)
      .filter(el => !(el.labels && el.labels.length) && !el.getAttribute('aria-label') && !el.textContent.trim())
      .map(el => el.id || el.outerHTML.slice(0, 60))""")
    assert not unlabeled, "controls without a label: %s" % unlabeled
    with pg.page.expect_file_chooser() as fc:
        pg.page.focus("#drop")
        pg.page.keyboard.press("Enter")
    assert fc.value is not None
    pg.close()


# ------------------------------------------------------------------ runner

def main():
    failed = 0
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for name, fn in results:
            t0 = time.time()
            try:
                fn(browser)
                print("PASS  %-62s %5.1fs" % (name, time.time() - t0))
            except Exception:
                failed += 1
                print("FAIL  %s" % name)
                traceback.print_exc()
        browser.close()
    print("\n%d checks, %d failed" % (len(results), failed))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
