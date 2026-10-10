# Native navigation artwork

Overview (`house`) and Settings (`settings`) reuse the Desktop Lucide artwork. Sessions uses Lucide `messages-square`, and Insights uses Lucide `chart-no-axes-combined`; the existing asset identifiers remain stable. Limits keeps the original Desktop filled gauge.

All five retain a 24 × 24pt square canvas and their original aspect ratio. Outline assets use a 2.1pt rendered stroke: the source stroke is divided by the artwork scale so geometry scaling does not also thicken the line. The gauge outer rim is approximately 2.1pt after scaling. Per-silhouette optical sizing balances enclosed and open forms. Xcode renders monochrome templates with preserved vectors.

Desktop sources: `src/electron/renderer/icons/views/home.svg`, `views/limits.svg`, and `actions/settings.svg`. Additional sources: https://github.com/lucide-icons/lucide/blob/main/icons/messages-square.svg and https://github.com/lucide-icons/lucide/blob/main/icons/chart-no-axes-combined.svg. The packaged `DesktopNavigation.LICENSE.txt` records attribution and licenses.
