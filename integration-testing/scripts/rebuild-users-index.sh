#!/usr/bin/env bash

set -a
[ -f .env ] && . .env
set +a

[ -z "$DYNAMODB_TABLE_NAME" ] && echo "Env var DYNAMODB_TABLE_NAME must be defined" && exit 1

rightNow=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
effectiveNow=${1:-$rightNow}
concurrency=10  # somewhat arbitrary

nextToken=""
while :; do

  echo "Pulling up to $concurrency user profiles to update to lastManuallyReindexedAt = $effectiveNow"
  cmd=(aws dynamodb scan)
  cmd+=('--table-name')
  cmd+=($DYNAMODB_TABLE_NAME)
  cmd+=('--projection-expression')
  cmd+=('partitionKey, sortKey')
  cmd+=('--max-items')
  cmd+=($concurrency)
  cmd+=('--filter-expression')
  cmd+=('sortKey = :sk and ( attribute_not_exists(lastManuallyReindexedAt) or lastManuallyReindexedAt < :now )')
  cmd+=('--expression-attribute-values')
  cmd+=("{\":sk\": {\"S\": \"profile\"}, \":now\": {\"S\": \"$effectiveNow\"}}")
  if [ ! -z "$nextToken" ]; then
    cmd+=('--starting-token')
    cmd+=("$nextToken")
  fi

  resp=$("${cmd[@]}")
  nextToken=$(echo $resp | jq -r .NextToken)
  itemsCnt=$(echo $resp | jq '.Items | length')
  echo $resp | jq --compact-output '.Items[]' | while read item; do

    cmd=(aws dynamodb update-item)
    cmd+=('--table-name')
    cmd+=($DYNAMODB_TABLE_NAME)
    cmd+=('--key')
    cmd+=($item)
    cmd+=('--update-expression')
    cmd+=('SET lastManuallyReindexedAt = :now')
    cmd+=('--expression-attribute-values')
    cmd+=("{\":now\": {\"S\": \"$effectiveNow\"}}")
    "${cmd[@]}" &

  done
  wait

  echo "Updated $itemsCnt user profiles from dynamo."

  [ -z "$nextToken" ] || [ "$nextToken" == "null" ] && break
  echo "Iterating with nextToken: $nextToken"
done