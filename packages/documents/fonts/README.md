# Bundled font

Roboto 3.016 (Regular and Medium, Medium is drawn as bold), copied from the files that pdfmake 0.3.15 ships.

Licence: SIL Open Font License 1.1, full text in `OFL.txt` (copied from https://github.com/googlefonts/roboto-3-classic (the font files' metadata names the earlier repository https://github.com/googlefonts/roboto-classic)). Copyright 2011 The Roboto Project Authors. The licence is also embedded in each file's name table, which was read from the files themselves: the pdfmake package is MIT, but the font is OFL, not Apache 2.0 as older Roboto releases were.

The files are unmodified. Umlauts and sharp s are covered; `src/render/render.test.ts` renders them and reads them back from the PDF.
