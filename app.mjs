// QUniverse's page bootstrap — side-effect imports only: each registers
// its own Custom Element tag, then `<qu-app-shell>` in index.html takes
// over. qu-core/src/bundles/ui.js registers the generic, reusable
// components (<qu-view>/<qu-list>/<qu-profile-card>/<qu-people-search>);
// the shell/*.mjs files are QUniverse's own, product-specific pieces
// (see each file's own doc comment for why they live here, not in Qu).
import './src/bundles/ui.js';
import './shell/qu-nav-dropdown.mjs';
import './shell/qu-notification-badge.mjs';
import './shell/qu-app-shell.mjs';
