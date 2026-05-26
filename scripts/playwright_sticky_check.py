"""Verify page-sticky-top: lifted 32px, no overlap, stable while scrolling."""
from __future__ import annotations

import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8484/"
OUT = Path(__file__).resolve().parent / "sticky-screenshots"


def _metrics(page) -> dict:
    return page.evaluate(
        """() => {
          const sticky = document.querySelector('.page-sticky-top');
          const pageEl = document.querySelector('.page');
          if (!sticky || !pageEl) return { error: 'missing sticky or page' };
          const sr = sticky.getBoundingClientRect();
          const pr = pageEl.getBoundingClientRect();
          const cs = getComputedStyle(sticky);
          const content =
            document.querySelector('.project-tree-list')
            || document.querySelector('.evolution-layout')
            || document.querySelector('.dashboard-grid')
            || sticky.nextElementSibling;
          const cr = content ? content.getBoundingClientRect() : null;
          return {
            pageScrollTop: pageEl.scrollTop,
            scrollHeight: pageEl.scrollHeight,
            clientHeight: pageEl.clientHeight,
            stickyTop: sr.top,
            stickyBottom: sr.bottom,
            stickyHeight: sr.height,
            pageTop: pr.top,
            position: cs.position,
            topCss: cs.top,
            marginTop: cs.marginTop,
            paddingTop: cs.paddingTop,
            marginBottom: cs.marginBottom,
            contentTop: cr ? cr.top : null,
            contentGap: cr ? cr.top - sr.bottom : null,
            pagePadTop: getComputedStyle(pageEl).paddingTop,
          };
        }"""
    )


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    errors: list[str] = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1280, "height": 720})
        page.goto(URL, wait_until="networkidle", timeout=90_000)

        if page.locator(".page-sticky-top").count() == 0:
            raise SystemExit("No .page-sticky-top found on page")

        rest = _metrics(page)
        page.screenshot(path=str(OUT / "after-top.png"))

        page.evaluate(
            """() => {
              const el = document.querySelector('.page');
              const list = document.querySelector('.project-tree-list')
                || document.querySelector('.evolution-grid')
                || document.querySelector('.dashboard-grid');
              if (list) list.style.minHeight = '2400px';
              if (el) el.scrollTop = 520;
            }"""
        )
        page.wait_for_timeout(400)
        scrolled = _metrics(page)
        page.screenshot(path=str(OUT / "after-scroll.png"))

        print("rest:", rest)
        print("scrolled:", scrolled)

        # Lifted ~32px from legacy baseline (stickyTop ≈ 28 → target ≤ 0).
        if rest["stickyTop"] > 1:
            errors.append(f"sticky not lifted enough: stickyTop={rest['stickyTop']}")

        # Content must start below sticky chrome (no layout overlap).
        if rest.get("contentGap") is not None and rest["contentGap"] < -1:
            errors.append(f"content overlaps sticky: gap={rest['contentGap']}")

        if scrolled["pageScrollTop"] < 100:
            errors.append(f"page did not scroll: scrollTop={scrolled['pageScrollTop']}")

        # Sticky must pin — top edge unchanged after scroll (within 1px).
        if abs(rest["stickyTop"] - scrolled["stickyTop"]) > 1:
            errors.append(
                f"sticky moved while scrolling: rest={rest['stickyTop']} scrolled={scrolled['stickyTop']}"
            )

        if rest["topCss"] != "0px":
            errors.append(f"expected top: 0, got {rest['topCss']}")

        browser.close()

    if errors:
        print("FAIL:")
        for e in errors:
            print(" -", e)
        raise SystemExit(1)
    print("PASS: sticky top lift / gap / scroll pin OK")


if __name__ == "__main__":
    main()
