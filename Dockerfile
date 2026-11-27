# Imatge estàtica: nginx servint l'aplicació (sense build de JS).
FROM nginx:1.27-alpine

# Configuració del servidor (revalidació sempre perquè es vegin els canvis)
COPY docker/default.conf /etc/nginx/conf.d/default.conf

# Contingut de l'aplicació
COPY index.html /usr/share/nginx/html/index.html
COPY css/ /usr/share/nginx/html/css/
COPY js/ /usr/share/nginx/html/js/

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/index.html >/dev/null || exit 1
