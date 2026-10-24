# Notch empty trailing-track regression

Evidence for [PR #1164](https://github.com/Javis603/token-monitor/pull/1164), whose reviewed feature head is `99385be50c897fe8827439341cc07df3dcdc2d55`.

These preserved images were captured during the earlier isolated Electron panel fixture, using synthetic readings and the production renderer in a hidden BrowserWindow. They are not fresh captures of the physical camera or OS compositor. The pre-fix image shows the unused trailing tab track as a faint dot to the right of the camera area; the fixed image hides that empty track. The old-build defect was also manually confirmed by the user.

The fixed fixture PNG is byte-identical to the locally retained main reference. This establishes only the specific fixture comparison; physical geometry, native input/composition and full application behavior need separate acceptance.

| File | SHA-256 |
| --- | --- |
| `before.png` | `5d98946f1f604c4fa00d04e5a26c0ec3822b97730562f68ce87a4445ce375b0c` |
| `after.png` | `e36b4d0f534337684c96f75cb8c185f4ad9db4f6a579605590204022cac0a761` |

The images are stored on the dedicated `evidence` branch so they are not part of the feature PR's source diff.
