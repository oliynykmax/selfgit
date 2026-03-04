FROM alpine:3.19

RUN apk add --no-cache git git-daemon fcgiwrap spawn-fcgi nginx apache2-utils

COPY nginx.conf /etc/nginx/nginx.conf
COPY git.conf /etc/nginx/git.conf
COPY start.sh /start.sh
RUN chmod +x /start.sh

RUN mkdir -p /git && \
    for i in 1 2 3 4 5 6 7 8 9 10; do \
        git init --bare /git/repo$i.git && \
        git -C /git/repo$i.git config http.receivepack true; \
    done && \
    chown -R nginx:nginx /git

EXPOSE 8080

CMD ["/start.sh"]
