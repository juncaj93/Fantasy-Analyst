# Data Model and Identity Rules

## Goal

Create one canonical player identity layer that can reconcile Sleeper, Underdog, newsletter text, and sportsbook prop feeds.

## Core entities

### players

Suggested fields:

- id
- sleeper_player_id
- full_name
- first_name
- last_name
- team
- position
- status
- active
- normalized_name
- aliases_json
- created_at
- updated_at

Sleeper ID should be the preferred external identity when available.

### player_aliases

- id
- player_id
- alias
- normalized_alias
- source
- confidence

Use aliases for:

- punctuation variants
- suffixes
- common abbreviations
- newsletter shorthand
- sportsbook naming variants

### leagues

- id
- sleeper_league_id
- name
- season
- scoring_settings_json
- roster_positions_json
- league_settings_json
- last_synced_at

### drafts

- id
- sleeper_draft_id
- league_id
- status
- type
- order_json
- settings_json
- last_synced_at

### draft_picks

- id
- draft_id
- sleeper_pick_no
- round
- pick_in_round
- player_id
- roster_id
- raw_json
- picked_at

### adp_snapshots

- id
- source
- label
- captured_at
- imported_at
- raw_file_hash

### adp_rows

- id
- snapshot_id
- player_id
- source_name
- source_player_name
- adp
- rank
- position
- raw_json

### evidence_items

Preserve every news item rather than only the aggregate tally.

Fields:

- id
- player_id
- source_type
- source_name
- source_message_id
- source_date
- excerpt
- context_summary
- category
- polarity
- magnitude
- confidence
- rule_id
- review_status
- user_override
- created_at

Suggested polarity:

- positive
- negative
- neutral
- mixed
- uncertain

Suggested magnitude:

- 1 default
- 2 meaningful
- 3 major

Do not invent magnitude rules until explicitly defined.

### player_signal_cache

Derived values only.

- player_id
- raw_positive_count
- raw_negative_count
- raw_net
- recent_positive
- recent_negative
- recent_net
- category_breakdown_json
- updated_at

This is a cache, not source of truth.

### prop_snapshots

- id
- provider
- event_id
- game_start
- fetched_at
- raw_json

### player_props

- id
- snapshot_id
- player_id
- market
- line
- over_price
- under_price
- book
- consensus_method
- raw_json

### user_reviews

Track correction history:

- id
- evidence_item_id
- previous_value_json
- new_value_json
- changed_at

## Identity matching order

Use strict matching first.

1. exact external provider ID mapping
2. exact normalized full name + team
3. exact normalized full name + position
4. known alias
5. fuzzy candidate generation only

Never automatically commit a fuzzy match unless confidence is extremely high and no conflicting active player exists.

Ambiguous player identity must enter review.

## Normalization

Normalize:

- apostrophes
- periods
- hyphens
- suffix punctuation
- multiple spaces
- accents where appropriate for lookup only

Preserve display names exactly.

## User corrections

User overrides are authoritative.

If the user corrects:

- player identity
- polarity
- category
- magnitude

persist the override and do not overwrite it during future reprocessing.
