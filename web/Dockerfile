# Serves the built web app (tools/build-web.sh writes web/public). Nothing is built here, so the files served are the ones whose hash was published.
FROM caddy:2.8.4-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY public /srv
