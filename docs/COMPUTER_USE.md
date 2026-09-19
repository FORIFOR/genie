# Computer use

The supported `computer.run` route now uses fresh screenshots, grounded image targets and a separate visual verifier.

Read [Screenshot-grounded computer use](COMPUTER_VISION.md) for setup, consent, model selection, limits and verification scope.

The old metadata-only planner and raw coordinate-input runner remain development modules, but are no longer registered as automatic execution fallbacks in the standard Agent Host. Legacy `computer.action` tasks fail as unsupported on this route rather than running ungrounded input.
