#!/bin/sh

# Generate htpasswd from GIT_TOKEN env var
# Username is "git", password is the token
if [ -n "$GIT_TOKEN" ]; then
    htpasswd -cb /etc/nginx/.htpasswd git "$GIT_TOKEN"
else
    # Default token if none set (change this!)
    htpasswd -cb /etc/nginx/.htpasswd git "changeme"
fi

# Fix git home to avoid /root access warnings
export HOME=/tmp

spawn-fcgi -s /tmp/fcgi.sock -u nginx -g nginx -- /usr/bin/env HOME=/tmp /usr/bin/fcgiwrap
chmod 777 /tmp/fcgi.sock
nginx -g "daemon off;"
