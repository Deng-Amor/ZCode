# CCode account UI

Desktop-only account entry, through useCcodeAccount and IPlatformService. No direct
IPC, Node service, tokens, controller contents or persistent account store.
Main owns identity; invalidation events and window focus trigger authoritative
reads. Per-hook generation numbers reject late reads. Read failure removes the
authenticated projection. Subscribe before initial read, unsubscribe on unmount.

The dialog loads tenants on open, accepts username/password, clears password on
submit and destroys form state on close. Errors are fixed localized messages;
never log server error objects or credentials. Successful login/getState includes
startup controller assembly. Existing custom model credentials remain separate.

CcodeStartupLogin wraps RootInner once per window load. Main state remains the
authentication authority. A one-way UI latch passes through after sign-in and
startup assembly; later logout never unmounts the workspace. Web without the port
passes through. Loading and read failure have distinct views; read failure can
retry. The existing form is reused; startup has no unauthenticated skip action.
An in-flight form stays mounted if a background state read fails, so its busy
completion is not lost. No startup dismissal or credential is persisted.

Bounded dialog shell uses overflow hidden; only inner form content scrolls.
The startup rendering regression verifies signed-out gating, signed-in entry and
Web pass-through. Static checks do not establish live authentication or accessibility.
