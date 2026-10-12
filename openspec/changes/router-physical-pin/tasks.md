# Tasks

## 1. Pin state and selection

- [ ] 1.1 Add the branch pin entry with last-wins restore; verify resume and fork restore the pin and `auto` clears it.
- [ ] 1.2 Pass the pin as the preferred identity after recovery and before the current physical model; verify an eligible pin is chosen and recovery keeps priority.
- [ ] 1.3 Verify a pin in cooldown or too small for a request falls back to route order and the pin still applies afterwards.

## 2. Command and picker

- [ ] 2.1 Add `/route-pin` with the picker, argument completion, and label/`auto` argument handling; verify unknown labels are rejected and the pin is unchanged.
- [ ] 2.2 Add the cache-rebuild notice to every manual change.

## 3. Cycle hotkey

- [ ] 3.1 Register the configurable `shortcuts.cyclePin` hotkey; verify the default `ctrl+shift+m` binding and that a config value overrides it.
- [ ] 3.2 Implement next-eligible cycling with wrap; verify wrap, and that no eligible candidate notifies without changing the pin.

## 4. Footer and log

- [ ] 4.1 Add the pin mark to the physical footer item; verify it shows for a dormant pin.
- [ ] 4.2 Log manual changes with reason `manual`; verify the decision log entry.

## 5. Documentation

- [ ] 5.1 Document the picker, argument form, hotkey config, dormant behaviour and cache notice in the router README.
