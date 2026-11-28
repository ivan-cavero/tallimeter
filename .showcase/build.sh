#!/bin/bash
# Builds the capture bundle from the real components. The host modules are stubbed from
# .showcase/shims and react-native runs as react-native-web, so this is the actual UI.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(dirname "$here")
esbuild="$here/../.showcase/node_modules/.bin/esbuild"

"$esbuild" "$here/entry.tsx" \
  --bundle --platform=browser --format=iife --jsx=automatic \
  --outfile="$here/showcase.js" \
  --alias:react-native=react-native-web \
  --alias:@getpaseo/plugin/client="$here/shims/plugin-client.tsx" \
  --alias:@getpaseo/plugin/client/ui="$here/shims/plugin-ui.tsx" \
  --alias:@tanstack/react-query="$here/shims/react-query.tsx" \
  --external:react --external:react-dom --external:react-native-web
