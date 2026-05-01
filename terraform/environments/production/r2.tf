# =============================================================================
# R2 Media Storage
# =============================================================================

# Disabled — R2 not activated on this Cloudflare account yet.
# Uncomment when R2 is enabled.
# resource "cloudflare_r2_bucket" "media" {
#   account_id = var.cloudflare_account_id
#   name       = "open-inspect-media-${local.name_suffix}"
#   location   = var.r2_media_location
# }
