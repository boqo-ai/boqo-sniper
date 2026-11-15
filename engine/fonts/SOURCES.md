# Bundled fonts

Both are licensed under the SIL Open Font License 1.1 (the licence files sit
beside them). `engine/captions-ass.mjs` names them in `FONT_FILES`; the render
passes this folder to libass as `fontsdir`.

| File | Family (name table) | Source |
| --- | --- | --- |
| `Inter-Bold.ttf` | Inter (Bold) | `extras/ttf/Inter-Bold.ttf` in https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip (Inter 4.1); licence `OFL-Inter.txt` is the zip's `LICENSE.txt` |
| `Anton-Regular.ttf` | Anton (Regular) | https://raw.githubusercontent.com/google/fonts/main/ofl/anton/Anton-Regular.ttf; licence `OFL-Anton.txt` from https://raw.githubusercontent.com/google/fonts/main/ofl/anton/OFL.txt |

SHA-256:

- `Inter-Bold.ttf` 288316099b1e0a47a4716d159098005eef7c0066921f34e3200393dbdb01947f
- `Anton-Regular.ttf` a4ba3a92350ebb031da0cb47630ac49eb265082ca1bc0450442f4a83ab947cab
