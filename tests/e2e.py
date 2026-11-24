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

from openpyxl import load_workbook
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

    def mech(self, value):
        """Choose a drive mechanism in the sidebar ('auto', 'depletion', 'gascap', 'water', 'combination')."""
        self.page.check("input[name=mech][value=%s]" % value)
        self.page.wait_for_timeout(50)

    def title(self):
        return self.text("#verdict-title")

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
    assert "found from the data" in pg.text("#verdict-k")
    assert "Gas cap, m = 0.542; no water influx" in pg.text("#verdict-sub"), pg.text("#verdict-sub")
    ev = pg.text("#evidence")
    assert "Depletion alone" in ev and "gas-cap line gives m = 0.542" in ev, ev
    assert pg.val("res-N") == "108.6" and pg.val("res-m") == "0.542" and pg.val("res-G") == "84.62"
    assert pg.page.locator("#res-We").is_hidden()
    assert "rounding the table" in pg.text("#res-N .res-ci")
    assert pg.page.locator("#shares .shares-bar span").count() == 2, "depletion and gas cap"
    assert pg.page.locator("#models tbody tr").count() == 4
    assert pg.page.locator("#models tr.is-chosen").count() == 1
    assert pg.page.locator("#chart-app svg").count() == 1
    assert pg.page.locator("#chart-ho circle.hit").count() == 6 and pg.fit_points() == 6
    assert pg.page.locator("#calc tbody tr").count() == 7
    assert "Example" in pg.text("#source")
    # initial values from the second sheet; S_wc, C_w and C_f are not given, so E_fw = 0 and the line is F/Eo against Eg/Eo
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


@check("Q2 data: water drive found; the gas-cap line by hand gives a negative m")
def t_q2(b):
    pg = Page(b)
    pg.upload(os.path.join(FIX, "q2_example.xlsx"))
    assert pg.page.locator("#alert").is_hidden()
    # found from the data: water drive (Dake's exercise 9.2), with the rows taken as equal time steps
    assert pg.title() == "Water drive"
    assert "found from the data" in pg.text("#verdict-k")
    sub = pg.text("#verdict-sub")
    assert "Unsteady-state aquifer" in sub and "equal time steps" in sub, sub
    ev = pg.text("#evidence")
    assert "cannot be negative" in ev and "K < 0" in ev and "Depletion alone" in ev, ev
    assert pg.val("res-N") == "286.6" and pg.val("res-m") == "0.000" and pg.val("res-G") == "0"
    assert pg.page.locator("#res-We").is_visible() and pg.val("res-We") == "96.95"
    assert "rounding the table" in pg.text("#res-N .res-ci")
    assert pg.page.locator("#shares .shares-bar span").count() == 3, "depletion, water and rock"
    assert "slope 1" in pg.page.locator("#chart-ho svg").text_content()
    assert pg.page.locator("#models tbody tr").count() == 8
    assert pg.page.locator("#models tr.is-chosen").count() == 1
    assert pg.page.locator("#chart-app svg").count() == 1
    assert pg.page.locator("#chart-ho circle.hit").count() == 10
    assert pg.page.locator("#calc tbody tr").count() == 11
    shot(pg, "desktop-q2", full=True)
    # the gas-cap line of the course table, chosen by hand
    pg.mech("gascap")
    assert pg.title() == "Gas-cap drive" and "chosen by you" in pg.text("#verdict-k")
    assert pg.val("res-N") == "729.9"
    assert pg.val("res-m") == "−0.070"
    assert pg.val("res-G") == "−79.53"
    assert "0.613" in pg.text("#fitline") and pg.fit_points() == 10
    assert pg.page.locator("#res-We").is_hidden()
    assert pg.page.locator("#res-m .res-flag").count() == 1, "negative m is flagged"
    assert pg.page.locator("#res-G .res-flag").count() == 1, "negative G is flagged"
    notes = pg.text("#notes")
    assert "negative" in notes and "R² = 0.613" in notes
    assert "2,500 and 2,290 psia" in notes, "rounding check names the sensitive points"
    # drive indices are hidden while m < 0, and come back once the two sensitive points are left out
    assert "Not shown" in pg.text("#chart-drive") and pg.page.locator("#chart-drive svg").count() == 0
    pg.page.click("#notes button[data-rows]")
    assert pg.val("res-m") == "0.00506" and pg.val("res-N") == "522.9"
    assert pg.page.locator("#chart-drive svg").count() == 1
    assert pg.page.locator("#res-G .res-flag").count() == 0
    pg.page.click("#reset-points")
    assert pg.val("res-N") == "729.9"
    pg.mech("auto")
    assert pg.title() == "Water drive" and pg.val("res-N") == "286.6"
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
        pg.mech("gascap")
        assert pg.val("res-N") == "729.9", f + " N=" + pg.val("res-N")
        assert pg.val("res-m") == "−0.070", f
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
    shot(pg, "desktop-error")
    pg.upload(os.path.join(FIX, "err_no_table.xlsx"))
    assert "No production table" in pg.text("#alert")
    pg.upload(os.path.join(SAMPLES, "havlena-odeh-template.xlsx"))
    assert "no rows with numbers" in pg.text("#alert")
    pg.page.click("#alert button[data-act=example]")
    assert pg.val("res-N") == "108.6"
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
    pg.upload(os.path.join(FIX, "q2_example.xlsx"))
    pg.mech("gascap")
    axes = lambda: pg.page.locator("#chart-ho svg").text_content()
    assert "Eg / [Eo + (1 + m) Efw]" in axes() and "F / [Eo + (1 + m) Efw], MMSTB" in axes(), axes()
    pg.page.uncheck("#efw")
    assert pg.val("res-N") == "705.3"
    assert "Eg / Eo" in axes() and "F / Eo, MMSTB" in axes(), axes()
    pg.page.check("#efw")
    assert pg.val("res-N") == "729.9"
    for k in ("Swc", "Cw", "Cf"):
        pg.page.fill("#prm-" + k, "0")
        pg.page.press("#prm-" + k, "Enter")
    assert pg.val("res-N") == "705.3"
    assert pg.text("#src-Cf").startswith("Your value")
    pg.page.click("#src-Cf .reset")
    pg.page.click("#src-Cw .reset")
    pg.page.click("#src-Swc .reset")
    assert pg.val("res-N") == "729.9"
    pg.page.fill("#prm-Boi", "abc")
    pg.page.press("#prm-Boi", "Enter")
    assert pg.page.get_attribute("#prm-Boi", "aria-invalid") == "true"
    pg.page.fill("#prm-Boi", "1.404")
    pg.page.press("#prm-Boi", "Enter")
    # compressibility typed with a unit
    pg.page.fill("#prm-Cf", "4 x 10-6 1/psi")
    pg.page.press("#prm-Cf", "Enter")
    assert pg.val("res-N") == "729.9"
    # columns
    pg.page.select_option("#col-Bg", "-1")
    assert "Missing column" in pg.text("#alert")
    pg.page.select_option("#col-Bg", "3")
    assert pg.page.locator("#alert").is_hidden() and pg.val("res-N") == "729.9"
    pg.page.select_option("#unit-Gp", "MMMSCF")
    assert pg.val("res-N") != "729.9"
    pg.page.select_option("#unit-Gp", "MMSCF")
    assert pg.val("res-N") == "729.9"
    # result units
    pg.page.select_option("#out-N", "STB")
    assert pg.val("res-N") == "729,867,795" and pg.text("#res-N .u") == "STB"
    pg.page.select_option("#out-G", "MMSCF")
    assert pg.val("res-G") == "−79,526"
    pg.close()


@check("m explorer: slider, number box and the scan chart")
def t_explorer(b):
    pg = Page(b)
    pg.mech("gascap")
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
    assert wb.sheetnames == ["Results", "Models", "Calculations", "Inputs", "Notes"]
    res = [r for r in wb["Results"].iter_rows(values_only=True) if r and r[0]]
    by = {(r[0], r[2]): r for r in res}
    assert any(r[0] == "Drive mechanism" and r[1].startswith("Gas-cap drive (found from the data)") for r in res)
    approx(by[("N, oil initially in place", "MMSTB")][1], 108.647, 1e-4)
    approx(by[("m, gas-cap to oil-zone volume ratio", "-")][1], 0.5416, 1e-3)
    approx(by[("G, gas-cap gas initially in place", "Bscf")][1], 84.619, 1e-4)
    assert by[("We, water influx at the last step", "rb")][1] is None
    models = list(wb["Models"].iter_rows(values_only=True))
    assert len(models) == 5 and sum(1 for r in models[1:] if r[-1] == "yes") == 1
    # F at 3,150 psia: Np Bo + (Gp - Np Rs) Bg = 3.295e6 x 1.2353 + (3.460e9 - 3.295e6 x 477) x 0.00092 rb
    approx(wb["Calculations"]["J3"].value, 5807535.7, 1e-6)
    p = grab("#csv-btn")
    text = open(p, encoding="utf-8-sig").read()
    assert text.startswith("t (years),p (psia),Np (STB)") and text.count("\n") == 7
    p = grab("#png-ho")
    assert open(p, "rb").read(8) == b"\x89PNG\r\n\x1a\n"
    pg.close()


@check("drive mechanism controls: W_e column, fitted and hand-set aquifers, time")
def t_drive_controls(b):
    pg = Page(b)
    # a file with a W_e column is used straight away
    pg.upload(os.path.join(FIX, "synthetic_we_column.xlsx"))
    assert pg.title() == "Combination drive: gas cap and water", pg.title()
    assert "from column" in pg.text("#aq-note")
    assert pg.val("res-N") == "120.0" and pg.val("res-m") == "0.300"
    assert pg.page.locator("#chart-drive svg").count() == 1
    assert "Water influx" in pg.text("#legend-drive")
    # the same reservoir without the column: the pot aquifer is found by least squares
    pg.upload(os.path.join(FIX, "synthetic_pot_aquifer.xlsx"))
    assert pg.page.is_disabled("#aq-model option[value=column]")
    assert pg.title() == "Combination drive: gas cap and water", pg.title()
    assert pg.val("res-N") == "120.0" and pg.val("res-m") == "0.300", (pg.val("res-N"), pg.val("res-m"))
    assert "K = 60,000 rb/psi" in pg.text("#aq-read"), pg.text("#aq-read")
    assert "(F − We)" in pg.page.locator("#chart-ho svg").text_content(), "y axis shows F − We"
    # trial and error: K by hand, then fitted again
    pg.page.fill("#aq-k", "20000")
    pg.page.press("#aq-k", "Enter")
    assert "set by you" in pg.text("#aq-read") and pg.val("res-N") != "120.0"
    pg.page.click("#aq-best")
    assert pg.val("res-N") == "120.0" and "K = 60,000 rb/psi" in pg.text("#aq-read")
    shot(pg, "desktop-influx", full=True)
    # a mechanism chosen by hand
    pg.mech("gascap")
    assert pg.title() == "Gas-cap drive" and pg.page.locator("#res-We").is_hidden()
    pg.mech("auto")
    # the Q2 data have no time column: with time unknown, no aquifer that needs time is tried
    pg.upload(os.path.join(FIX, "q2_example.xlsx"))
    assert pg.page.locator("#aq-time").is_visible()
    pg.page.select_option("#aq-steps", "none")
    assert pg.title() == "Depletion drive", pg.title()
    assert "misses F" in pg.text("#notes")
    pg.page.select_option("#aq-steps", "auto")
    assert pg.title() == "Water drive"
    # the aquifer size by hand
    pg.page.select_option("#aq-model", "veh")
    pg.page.select_option("#aq-red", "5")
    assert "re/ro = 5" in pg.text("#verdict-sub").replace("\n", ""), pg.text("#verdict-sub")
    pg.close()


@check("each mechanism is found from its sample file")
def t_samples(b):
    pg = Page(b)
    cases = [
        ("drive_depletion_N150.xlsx", "Depletion drive", "150.0", "Solution gas"),
        ("drive_water_unsteady_N150.xlsx", "Water drive", "150.0", "Unsteady-state aquifer"),
        ("drive_gascap_water_N150_m030.xlsx", "Combination drive: gas cap and water", "150.0", "Pot aquifer"),
        ("drive_undersaturated_N150.xlsx", "Depletion drive", "150.0", "above the bubble point"),
        ("havlena-odeh-example.xlsx", "Gas-cap drive", "108.6", "Gas cap, m = 0.542"),
    ]
    for f, title, N, sub in cases:
        pg.upload(os.path.join(SAMPLES, f))
        assert pg.page.locator("#alert").is_hidden(), f + ": " + pg.text("#alert")
        assert pg.title() == title, f + ": " + pg.title()
        if N:
            assert pg.val("res-N") == N, f + " N=" + pg.val("res-N")
        assert sub.lower() in pg.text("#verdict-sub").lower(), f + ": " + pg.text("#verdict-sub")
        if f == "drive_water_unsteady_N150.xlsx":
            assert "equal time steps" not in pg.text("#verdict-sub"), "the time column is used"
            assert pg.page.locator("#calc thead").inner_text().startswith("Data") and "years" in pg.page.locator("#calc thead").inner_text()
        if f == "drive_undersaturated_N150.xlsx":
            assert pg.page.is_disabled("input[name=mech][value=gascap]")
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
