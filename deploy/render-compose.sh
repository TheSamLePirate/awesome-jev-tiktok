#!/bin/sh
# deploy/compose.yml with its image: render-compose.sh <image> > compose.yml
set -eu
sed -e "s|__JEV_IMAGE__|$1|" "$(dirname "$0")/compose.yml"
