# KESTREL-WEB: the Kestrel web

A small private web for Kestrel OS. It is not connected to the internet at large.

## Addresses
- `kes://name/page` is an open site: the folder `sites/name/` in this repository (anyone can add one).
- `kess://name/page` is a secure site: the folder `secure/name/`, reviewed and added only by the project owner. The browser marks these pages SECURE.
- `kes://name/` opens `index.html`; `kes://name/page` opens `page.html`. `kes://search?q=words` is the search engine.
- The browser refuses `http://` and `https://` addresses.

## A site
A folder with `index.html` (plain HTML: headings, paragraphs, lists, links; scripts, styles and images are ignored) and `site.txt`:

    name=My Site
    owner=me
    description=One sentence about the site
    tags=a few words people might search for

Link to other pages with relative links (`wifi.html`, `../home/`, `../../secure/kestrel/`).

## Search
Run `python3 tools/index.py` after changing any site and commit the new `_search/` folder. It writes one file per word,
`_search/<word>.txt`, with lines `score|address|title|snippet`, best first. The browser downloads the files for the words you type
and keeps pages that match all of them. Titles count most, then tags, name, description and body.
Tests: `python3 tests/test_index.py`.

## Browser
`app/browser.kest` is Kestrel Browser 3.0 (source `app/browser.kes`). Put it in the KESTREL-APPS repository as `browser.kest`, then install it with `app install browser`.
