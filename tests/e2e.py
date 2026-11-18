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
    assert pg.val("res-N") == "729.6"
    assert pg.val("res-m") == "−0.070"
    assert pg.val("res-G") == "−79.43"
    assert "0.618" in pg.text("#fitline") and pg.fit_points() == 10
    assert pg.page.locator("#chart-ho circle.hit").count() == 10
    assert pg.page.locator("#calc tbody tr").count() == 11
    assert "Example" in pg.text("#source")
    assert pg.page.locator("#res-m .res-flag").count() == 1, "negative m is flagged"
    notes = pg.text("#notes")
    assert "negative" in notes and "R² = 0.618" in notes
    shot(pg, "desktop-light", full=True)
    pg.close()


@check("every layout of the example gives the same answer")
def t_layouts(b):
    pg = Page(b)
    for f in sorted(os.listdir(FIX)):
        if not f.startswith("q2_") or f.endswith((".xls", ".ods")):
            continue
        pg.upload(os.path.join(FIX, f))
        assert pg.page.locator("#alert").is_hidden(), f + ": " + pg.text("#alert")
        assert pg.val("res-N") == "729.6", f + " N=" + pg.val("res-N")
        assert pg.val("res-m") == "−0.070", f
        assert pg.fit_points() == 10, f
    pg.close()


@check("second example, known-answer sample and a 400-row file")
def t_other_data(b):
    pg = Page(b)
    pg.upload(os.path.join(FIX, "q1_two_row_header.xlsx"))
    assert pg.val("res-N") == "108.6" and pg.val("res-m") == "0.542" and pg.val("res-G") == "84.62"
    assert "E" in pg.text("#notes") and "neglected" in pg.text("#notes")
    shot(pg, "desktop-q1")
    pg.upload(os.path.join(SAMPLES, "known_answer_N150_m040.xlsx"))
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
    assert pg.val("res-N") == "729.6", "previous result kept"
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
    assert pg.val("res-N") == "729.6"
    pg.close()


@check("points can be left out from the table, the plot and the keyboard")
def t_exclude(b):
    pg = Page(b)
    pg.page.uncheck("#calc tbody tr:nth-child(2) input[type=checkbox]")
    assert pg.fit_points() == 9
    assert pg.page.locator("#reset-points").is_visible()
    assert pg.val("res-N") != "729.6"
    pg.page.click("#reset-points")
    assert pg.fit_points() == 10
    pg.page.locator("#chart-ho circle.hit").first.focus()
    pg.page.keyboard.press("Enter")
    assert pg.fit_points() == 9
    assert pg.page.evaluate("document.activeElement.classList.contains('hit')"), "focus stays on the point"
    pg.page.keyboard.press("Enter")
    assert pg.fit_points() == 10
    pg.page.locator("#chart-ho circle.hit").nth(3).click()
    assert pg.fit_points() == 9
    pg.close()


@check("parameters, E_fw switch, columns and units drive the answer")
def t_inputs(b):
    pg = Page(b)
    pg.page.uncheck("#efw")
    assert pg.val("res-N") == "705.3"
    pg.page.check("#efw")
    assert pg.val("res-N") == "729.6"
    for k in ("Swc", "Cw", "Cf"):
        pg.page.fill("#prm-" + k, "0")
        pg.page.press("#prm-" + k, "Enter")
    assert pg.val("res-N") == "705.3"
    assert pg.text("#src-Cf").startswith("Your value")
    pg.page.click("#src-Cf .reset")
    pg.page.click("#src-Cw .reset")
    pg.page.click("#src-Swc .reset")
    assert pg.val("res-N") == "729.6"
    pg.page.fill("#prm-Boi", "abc")
    pg.page.press("#prm-Boi", "Enter")
    assert pg.page.get_attribute("#prm-Boi", "aria-invalid") == "true"
    pg.page.fill("#prm-Boi", "1.404")
    pg.page.press("#prm-Boi", "Enter")
    # compressibility typed with a unit
    pg.page.fill("#prm-Cf", "4 x 10-6 1/psi")
    pg.page.press("#prm-Cf", "Enter")
    assert pg.val("res-N") == "729.6"
    # columns
    pg.page.select_option("#col-Bg", "-1")
    assert "Missing column" in pg.text("#alert")
    pg.page.select_option("#col-Bg", "3")
    assert pg.page.locator("#alert").is_hidden() and pg.val("res-N") == "729.6"
    pg.page.select_option("#unit-Gp", "MMMSCF")
    assert pg.val("res-N") != "729.6"
    pg.page.select_option("#unit-Gp", "MMSCF")
    assert pg.val("res-N") == "729.6"
    # result units
    pg.page.select_option("#out-N", "STB")
    assert pg.val("res-N") == "729,618,154" and pg.text("#res-N .u") == "STB"
    pg.page.select_option("#out-G", "MMSCF")
    assert pg.val("res-G") == "−79,433"
    pg.close()


@check("m explorer: slider, number box and the scan chart")
def t_explorer(b):
    pg = Page(b)
    pg.page.fill("#m-num", "0.3")
    pg.page.press("#m-num", "Enter")
    assert "0.300" in pg.text("#m-read")
    assert pg.page.locator("#chart-exp svg").count() == 1 and pg.page.locator("#chart-scan svg").count() == 1
    pg.page.click("#m-fit")
    assert "−0.070" in pg.text("#m-read")
    overlay = pg.page.locator("#chart-scan svg rect[fill=transparent]")
    overlay.scroll_into_view_if_needed()
    box = overlay.bounding_box()
    pg.page.mouse.click(box["x"] + box["width"] * 0.8, box["y"] + box["height"] / 2)
    assert "−0.070" not in pg.text("#m-read").split(",")[0]
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
    assert wb["Production"]["B1"].value == "Np (MMSTB)"
    p = grab("#dl-example")
    wb = load_workbook(p)
    assert wb["Production"]["A3"].value == 2500
    # the example file reads back into the same answer
    pg.upload(p)
    assert pg.val("res-N") == "729.6"
    p = grab("#export-btn")
    wb = load_workbook(p)
    assert wb.sheetnames == ["Results", "Calculations", "Inputs", "Notes"]
    rows = {(r[0], r[2]): r for r in wb["Results"].iter_rows(values_only=True) if r and r[0]}
    approx(rows[("N, oil initially in place", "STB")][1], 729.618e6)
    approx(rows[("N, oil initially in place", "MMSTB")][1], 729.618)
    approx(rows[("m, gas-cap to oil-zone volume ratio", "-")][1], -0.069788)
    approx(rows[("G, gas-cap gas initially in place", "Bscf")][1], -79.4329)
    approx(wb["Calculations"]["I3"].value, 12.151e6, 1e-3)
    p = grab("#csv-btn")
    text = open(p, encoding="utf-8-sig").read()
    assert text.startswith("p (psia),Np (STB)") and text.count("\n") == 11
    p = grab("#png-ho")
    assert open(p, "rb").read(8) == b"\x89PNG\r\n\x1a\n"
    pg.close()


@check("drag and drop a file onto the page")
def t_drop(b):
    pg = Page(b)
    data = base64.b64encode(open(os.path.join(FIX, "q1_simple.xlsx"), "rb").read()).decode()
    pg.page.evaluate("""(b64) => {
      const bin = atob(b64), arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const file = new File([arr], 'dropped.xlsx');
      const dt = new DataTransfer(); dt.items.add(file);
      window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }""", data)
    pg.page.wait_for_function("document.querySelector('#source').textContent.includes('dropped.xlsx')")
    assert pg.val("res-N") == "108.6"
    assert pg.page.locator("#drop-overlay").is_hidden()
    pg.close()


@check("phone width: no sideways scrolling, results readable")
def t_mobile(b):
    pg = Page(b, width=390, height=844)
    assert pg.page.evaluate("document.documentElement.scrollWidth") <= 390
    assert pg.val("res-N") == "729.6"
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
