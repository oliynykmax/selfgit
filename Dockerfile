FROM alpine:3.19

RUN apk add --no-cache git git-daemon fcgiwrap spawn-fcgi nginx apache2-utils

COPY nginx.conf /etc/nginx/nginx.conf
COPY git.conf /etc/nginx/git.conf
COPY start.sh /start.sh
RUN chmod +x /start.sh

RUN mkdir -p /git && \
    git init --bare /git/repo.git && \
    git -C /git/repo.git config http.receivepack true && \
    chown -R nginx:nginx /git

EXPOSE 8080

CMD ["/start.sh"]
