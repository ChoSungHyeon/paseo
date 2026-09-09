# Terminal title loading QA

Linux Chromium with an isolated real daemon. Before the change, reloading a manually renamed terminal produced ["Terminal", "My named terminal"]. Afterward the same journey produced ["", "My named terminal"], with the empty text occupied by the existing loading skeleton. First workspace visit and warm switching passed too.

Screenshots show the changed app during loading and after loading. Real metadata responses were held briefly only for these screenshots. The failing-before/passing-after regression and separate renamed/OSC-title QA used normal response timing.

No Windows, macOS, Electron, or native mobile runtime coverage is claimed. This does not establish a fix for issue #4521.
