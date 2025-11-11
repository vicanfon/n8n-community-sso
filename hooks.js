module.exports = {
  n8n: {
    ready: [
      async function ({ app }, config) {
        console.log('[HOOK DEBUG] External hook is being loaded!');
        const headerName = process.env.N8N_FORWARD_AUTH_HEADER;
        console.log(`[HOOK DEBUG] N8N_FORWARD_AUTH_HEADER = ${headerName}`);
        if (!headerName) {
          console.log('[HOOK DEBUG] No header name set, exiting');
          this.logger?.info('N8N_FORWARD_AUTH_HEADER not set; SSO middleware disabled.');
          return;
        }

        console.log(`[HOOK DEBUG] SSO middleware initializing with header: ${headerName}`);
        this.logger?.info(`SSO middleware initializing with header: ${headerName}`);

        const Layer = require('router/lib/layer');
        const { dirname, resolve } = require('path');
        const { randomBytes } = require('crypto');
        const { hash } = require('bcryptjs');
        const { issueCookie } = require(resolve(dirname(require.resolve('n8n')), 'auth/jwt'));

        // Trust the proxy for correct X-Forwarded-* handling and rate limiting
        app.set('trust proxy', 1);

        const ignoreAuth = /^\/(assets|healthz|webhook|rest\/oauth2-credential|health)/;
        const cookieName = 'n8n-auth';

        const UserRepo = this.dbCollections.User;
        const RoleRepo = this.dbCollections.Role;

        const { stack } = app.router;
        const idx = stack.findIndex((l) => l?.name === 'cookieParser');

        const layer = new Layer('/', { strict: false, end: false }, async (req, res, next) => {
          try {
            console.log(`[HOOK DEBUG] Middleware triggered for URL: ${req.url}`);
            // Skip if URL matches ignore list
            if (ignoreAuth.test(req.url)) {
              console.log(`[HOOK DEBUG] URL ${req.url} matches ignore list, skipping`);
              return next();
            }

            // Skip if instance owner is already set up
            const instanceOwnerSetUp = config.get('userManagement.isInstanceOwnerSetUp', false);
            console.log(`[HOOK DEBUG] instanceOwnerSetUp = ${instanceOwnerSetUp}`);
            if (instanceOwnerSetUp) {
              console.log('[HOOK DEBUG] Instance owner already set up, SSO will work normally');
            } else {
              console.log('[HOOK DEBUG] Instance owner not set up, SSO will create/login users');
            }

            // Skip if auth cookie already present
            console.log(`[HOOK DEBUG] Checking for auth cookie: ${cookieName}, present: ${!!req.cookies?.[cookieName]}`);
            if (req.cookies?.[cookieName]) {
              console.log('[HOOK DEBUG] Auth cookie present - EXITING');
              return next();
            }

            // Read email and optional names from headers/JWT
            const emailHeader = req.headers[headerName.toLowerCase()] ?? req.headers[headerName];
            console.log(`[HOOK DEBUG] Headers received: ${JSON.stringify({
              'remote-email': req.headers['remote-email'],
              'Remote-Email': req.headers['Remote-Email'],
              'authorization': req.headers['authorization'] ? 'present' : 'absent',
              'x-auth-request-access-token': req.headers['x-auth-request-access-token'] ? 'present' : 'absent'
            })}`);
            const authHeader = req.headers['authorization'] || req.headers['x-auth-request-access-token'] || '';
            let firstName = '';
            let lastName = '';

            // Try to extract given/family names from JWT payload
            if (authHeader) {
              try {
                const token = String(authHeader).replace(/^Bearer\s+/i, '');
                const parts = token.split('.');
                if (parts.length === 3) {
                  const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
                  firstName = payload.given_name || payload.firstName || '';
                  lastName = payload.family_name || payload.lastName || '';
                  this.logger?.debug(`Extracted from JWT: firstName="${firstName}", lastName="${lastName}"`);
                }
              } catch (e) {
                this.logger?.debug(`Failed to decode JWT: ${e.message}`);
              }
            }

            // Fallback to proxy headers if JWT didn’t contain names
            if (!firstName) firstName = req.headers['remote-given-name'] || '';
            if (!lastName) lastName = req.headers['remote-family-name'] || '';

            // If the forward-auth header with email is missing — do nothing
            if (!emailHeader) {
              console.log(`[HOOK DEBUG] No ${headerName} header found, skipping SSO auto-login`);
              this.logger?.debug(`No ${headerName} header found, skipping SSO auto-login`);
              return next();
            }

            const userEmail = Array.isArray(emailHeader) ? emailHeader[0] : String(emailHeader).trim();
            const userFirstName = Array.isArray(firstName) ? firstName[0] : String(firstName).trim();
            const userLastName = Array.isArray(lastName) ? lastName[0] : String(lastName).trim();

            if (!userEmail) {
              console.log(`[HOOK DEBUG] Empty ${headerName} header, skipping SSO auto-login`);
              this.logger?.debug(`Empty ${headerName} header, skipping SSO auto-login`);
              return next();
            }

            console.log(`[HOOK DEBUG] SSO auto-login attempt for email: ${userEmail}, firstName: ${userFirstName}, lastName: ${userLastName}`);
            this.logger?.info(`SSO auto-login attempt for email: ${userEmail}`);

            // 1) Try to fetch the user including the 'role' relation (needed by n8n 1.112.6)
            let user = await UserRepo.findOne({
              where: { email: userEmail },
              relations: ['role'],
            });

            // 2) If not found — create the user and a project
            if (!user) {
              const hashed = await hash(randomBytes(16).toString('hex'), 10);

              // Check if this should be the instance owner (first user)
              const userCount = await UserRepo.count();
              const isFirstUser = userCount === 0;
              const userRole = isFirstUser ? 'global:owner' : 'global:member';

              const userData = {
                email: userEmail,
                role: userRole, // string-based role is valid for createUserWithProject
                password: hashed,
              };
              if (userFirstName) userData.firstName = userFirstName;
              if (userLastName) userData.lastName = userLastName;

              const created = await UserRepo.createUserWithProject(userData);
              user = created.user;

              const roleLabel = isFirstUser ? 'instance owner' : 'member';
              this.logger?.info(`Created new user as ${roleLabel}: ${userEmail} (${userFirstName} ${userLastName}) via SSO`);
            } else {
              // 3) Update first/last name if they changed upstream
              let changed = false;
              if (userFirstName && user.firstName !== userFirstName) {
                user.firstName = userFirstName;
                changed = true;
              }
              if (userLastName && user.lastName !== userLastName) {
                user.lastName = userLastName;
                changed = true;
              }
              if (changed) {
                await UserRepo.save(user);
                this.logger?.info(`Updated user: ${userEmail} (${userFirstName} ${userLastName}) via SSO`);
              } else {
                this.logger?.info(`Existing user logged in: ${userEmail} via SSO`);
              }
            }

            // 4) Ensure 'user.role' exists (critical in 1.112.6, which dereferences role.slug)
            if (!user.role) {
              // Try to load by roleId
              if (user.roleId && RoleRepo) {
                user.role = await RoleRepo.findOneBy({ id: user.roleId });
              } else {
                // As a last resort, reload the user with relations
                const reloaded = await UserRepo.findOne({
                  where: { id: user.id },
                  relations: ['role'],
                });
                if (reloaded) user = reloaded;
              }
            }

            if (!user.role || !user.role.slug) {
              // Without a valid role cookie issuance will crash on 1.112.6
              this.logger?.error(`User ${userEmail} has no valid role; cannot issue cookie.`);
              res.statusCode = 401;
              res.end(`User ${userEmail} has no valid role. Ask admin to assign a role.`);
              return;
            }

            // 5) Issue n8n auth cookie (alt: this.auth.issueCookie(res, user, project))
            issueCookie(res, user);

            // 6) Attach context for downstream middleware/routes
            req.user = user;
            req.userId = user.id;

            return next();
          } catch (error) {
            this.logger?.error(`SSO middleware error: ${error.message}`);
            return next(error);
          }
        });

        // Insert our middleware right after cookieParser
        stack.splice(idx + 1, 0, layer);
        this.logger?.info('SSO middleware initialized successfully');

        // Logout endpoint: clear n8n cookie and redirect to your IdP logout
        app.get('/logout', (req, res) => {
          this.logger?.info('User logout initiated');
          res.clearCookie(cookieName, { path: '/' });
          res.redirect('/oauth2/sign_out?rd=http://localhost:8080/realms/demo/protocol/openid-connect/logout');
        });
      }
    ]
  }
};
