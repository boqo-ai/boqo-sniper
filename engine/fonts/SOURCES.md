# Bundled fonts

The faces boqo's worker image installs (`apps/worker/Dockerfile` at boqo-ai/boqo `bcc9d99cc`), so captions draw here
as they draw there. `engine/boqo/caption-faces.mjs` (`CAPTION_FACES`) names them by family; the render hands this
folder to libass as `fontsdir`, and libass finds each face by its family name.

Every file is redistributable with the licence file beside it: SIL Open Font License 1.1 (OFL), Apache License 2.0,
or, for DejaVu Sans, the Bitstream Vera licence with the DejaVu changes in the public domain (free to copy and
redistribute; not to be sold by itself).

`G` below is `https://raw.githubusercontent.com/google/fonts/6a003b5eb672dc8bf5bff5937cf5863f8b175445`, the
Dockerfile's `GOOGLE_FONTS_SHA`. One fetch per file, 2026-11-16.

| File | Family (as libass resolves it) | Source | Licence |
| --- | --- | --- | --- |
| `Montserrat-ExtraBold.ttf` | Montserrat ExtraBold | derived from `G/ofl/montserrat/Montserrat%5Bwght%5D.ttf` (see below) | OFL, `OFL-Montserrat.txt` from `G/ofl/montserrat/OFL.txt` |
| `Oswald-Bold.ttf` | Oswald (Bold) | derived from `G/ofl/oswald/Oswald%5Bwght%5D.ttf` (see below) | OFL, `OFL-Oswald.txt` from `G/ofl/oswald/OFL.txt` |
| `Anton-Regular.ttf` | Anton | `G/ofl/anton/Anton-Regular.ttf` | OFL, `OFL-Anton.txt` from `G/ofl/anton/OFL.txt` |
| `BebasNeue-Regular.ttf` | Bebas Neue | `G/ofl/bebasneue/BebasNeue-Regular.ttf` | OFL, `OFL-BebasNeue.txt` from `G/ofl/bebasneue/OFL.txt` |
| `Bangers-Regular.ttf` | Bangers | `G/ofl/bangers/Bangers-Regular.ttf` | OFL, `OFL-Bangers.txt` from `G/ofl/bangers/OFL.txt` |
| `Poppins-Black.ttf` | Poppins Black | `G/ofl/poppins/Poppins-Black.ttf` | OFL, `OFL-Poppins.txt` from `G/ofl/poppins/OFL.txt` |
| `ArchivoBlack-Regular.ttf` | Archivo Black | `G/ofl/archivoblack/ArchivoBlack-Regular.ttf` | OFL, `OFL-ArchivoBlack.txt` from `G/ofl/archivoblack/OFL.txt` |
| `LuckiestGuy-Regular.ttf` | Luckiest Guy | `G/apache/luckiestguy/LuckiestGuy-Regular.ttf` | Apache 2.0, `LICENSE-LuckiestGuy.txt` from `G/apache/luckiestguy/LICENSE.txt` |
| `PermanentMarker-Regular.ttf` | Permanent Marker | `G/apache/permanentmarker/PermanentMarker-Regular.ttf` | Apache 2.0, `LICENSE-PermanentMarker.txt` from `G/apache/permanentmarker/LICENSE.txt` |
| `Inter-Bold.otf` | Inter (Bold) | `/usr/share/fonts/opentype/inter/Inter-Bold.otf` of Debian bookworm's `fonts-inter` 4.0~beta7+ds-1, the Dockerfile's apt `fonts-inter`: https://deb.debian.org/debian/pool/main/f/fonts-inter/fonts-inter_4.0~beta7+ds-1_all.deb (sha256 `6afd9014550e04b58bccf64b94f92ae1dbfd8018489b92de835408970234c24c`) | OFL, `OFL-Inter.txt` from https://raw.githubusercontent.com/rsms/inter/v4.0-beta7/LICENSE.txt |
| `DejaVuSans-Bold.ttf` | DejaVu Sans (Bold) | `/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf` of Debian bookworm's `fonts-dejavu-core` 2.37-6, the Dockerfile's apt `fonts-dejavu-core`: https://deb.debian.org/debian/pool/main/f/fonts-dejavu/fonts-dejavu-core_2.37-6_all.deb (sha256 `8892669e51aab4dc56682c8e39d8ddb7d70fad83c369344e1e240bf3ca22bb76`) | Bitstream Vera + public domain, `LICENSE-DejaVu.txt` from https://raw.githubusercontent.com/dejavu-fonts/dejavu-fonts/version_2_37/LICENSE |

Montserrat and Oswald are the Cyrillic covering faces too (`coveringFace`): none of the seven display faces draws
Cyrillic, so a Cyrillic clip in one of them is drawn in Montserrat ExtraBold or Oswald.

## Montserrat and Oswald are static copies of the variable fonts

The image installs `Montserrat[wght].ttf` and `Oswald[wght].ttf`, variable fonts, system-wide, where fontconfig lists
every named instance and libass draws `Montserrat_800wght` and `Oswald_700wght`. Through `fontsdir` libass registers
only a variable font's default instance (measured 2026-11-16, BtbN ffmpeg 8.1): "Montserrat ExtraBold" found no face
and fell back to a system font, and "Oswald" Bold drew `Oswald-Regular`, a silent wrong face either way. So the two
named instances are bundled as static fonts, made from the pinned files by `scripts/fonts/static_instance.py` (in boqo-clips)
(fontTools 4.60.1: the instance at wght 800 and wght 700, names from STAT, and the default instance's OS/2 weight and
style bits, which make libass embolden them as it emboldens the named instances in the image). OFL 1.1 allows
modified versions under the same licence; neither family declares a Reserved Font Name. Input sha256:

- `Montserrat[wght].ttf` 0f7b311b2f3279e4eef9b2f968bcdbab6e28f4daeb1f049f4f278a902bcd82f7
- `Oswald[wght].ttf` 5b38c246e255a12f5712d640d56bcced0472466fc68983d2d0410ec0457c2817

## Checked against the image

- Every downloaded font file is byte-identical to the file of the same name in the worker image: sha256 compared
  with the files copied out of `boqo-render:latest` (built 2026-10-06) and `boqo-render:stream-panels` (built
  2026-11-10), which agree with each other.
- `scripts/fonts/verify-in-image.sh` (in boqo-clips) renders four lines per face at its `CAPTION_FACES` Bold flag inside the image,
  with the image's own fonts and then through `fontsdir` with this folder (the image's files moved away): 2026-11-16,
  nine faces pixel-identical; Oswald 169 pixels differ and Montserrat ExtraBold 17,004 (anti-aliasing; every line's
  left and right ink edges agree to the pixel, Montserrat's bottom by one row on one line; ink sums 1.0000 and 1.0017).
- `caption-metrics-table.mjs` (boqo's measured advances, the widths every line break is computed from) is generated
  data, measured by boqo inside its image: the seven display faces on 2026-10-05 (63c482a99), the first four entries
  kept from 2026-08-25 (its header: a regeneration then moved two advances by 1 px). The google/fonts commit has been
  the Dockerfile's pin since it first installed fonts (70e432746, 2026-08-25; `git log -S` finds no other), and the
  apt fonts come from bookworm, so these are the files it was measured from; the Dockerfile itself records no sha256.

## SHA-256

- `Montserrat-ExtraBold.ttf` 4ad374117a6639eaae456f77f9a0ca3694d46556f9d5f19f30ba0233a1cbe6bd
- `Oswald-Bold.ttf` adc5691aa1918045bb7cf65a27a602f4ab31c63fd0f18133089c9392e57534e5
- `Anton-Regular.ttf` a4ba3a92350ebb031da0cb47630ac49eb265082ca1bc0450442f4a83ab947cab
- `BebasNeue-Regular.ttf` 08e4623805102d819f58601e46e345648846075e363b2ceb23313c2d1c83ec73
- `Bangers-Regular.ttf` 4160a7311de9342674cce9160cde9fcbb30f48190397d86ff1b70b455af65824
- `Poppins-Black.ttf` d82aaaf98a9283f9a8edd24e51173337d8eaf09e25cd3d98831f8ec8461748a1
- `ArchivoBlack-Regular.ttf` dd9a89a019b4849f66ab75455fe7bdf931311042cbb0f0f97acc061539703180
- `LuckiestGuy-Regular.ttf` cfbdd68a039f92df51cf3721506af6242e64594c6325fe0bedbeff3fe385d980
- `PermanentMarker-Regular.ttf` 28f82c8a7943cb8e9d599f8554da1d4fc75dbcf69b9885ad6c0611d20c6946c5
- `Inter-Bold.otf` 1e9dfd6a6e33ac63a8fe3b4ed7ae0df9eac2d0b25e444e8e7daef4ac77943fc1
- `DejaVuSans-Bold.ttf` 0d977336a6d5fba34eab8e3199eb218327161b5143749f802982c2bc34df0c96
- `OFL-Montserrat.txt` 8b7141c03fa4f8d44e6345d5d4931709290f0f67875e452e95ac1fd3a027802e
- `OFL-Oswald.txt` 0fd731a904b729a4e02eaf5e8ebd06783edd9abe400e8882760160230675b652
- `OFL-Anton.txt` ee67e6ee22790b7929f1a3769ca2801d565c64b5a9096942c1adf5596de9c9e4
- `OFL-BebasNeue.txt` 72082f6cb4d04be2ecf7cc7d9e1e7d73787f0af8a5a278a47cade70c16b78341
- `OFL-Bangers.txt` 630dd5a307c0657b094d324e069b390edf90182fe5003639e06c02a0e5769af7
- `OFL-Poppins.txt` 6be04893d770899a015649c7aa3b582f871b272f8747a92b78b17c3e5c8b2573
- `OFL-ArchivoBlack.txt` 3173acd82f8c6159b5b1037b539fcbd4edff68e65c2ea8b9412b5a5ca97b08ff
- `LICENSE-LuckiestGuy.txt` cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30
- `LICENSE-PermanentMarker.txt` cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30
- `OFL-Inter.txt` 4d7d9c95e7d7f2f0ebf76d5e0b344826b74e903a34028ee18ab54bb639e45906
- `LICENSE-DejaVu.txt` 7a083b136e64d064794c3419751e5c7dd10d2f64c108fe5ba161eae5e5958a93
