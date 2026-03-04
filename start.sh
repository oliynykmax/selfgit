#!/bin/sh
spawn-fcgi -s /tmp/fcgi.sock -u nginx -g nginx /usr/bin/fcgiwrap
chmod 777 /tmp/fcgi.sock
nginx -g "daemon off;"
