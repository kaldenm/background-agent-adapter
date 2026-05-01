# Terraform State Backend Configuration
# Uses Cloudflare R2 (S3-compatible storage)
#
# Prerequisites:
# 1. Create R2 bucket: wrangler r2 bucket create open-inspect-terraform-state
# 2. Generate R2 API token with read/write permissions
# 3. Initialize with:
#    terraform init \
#      -backend-config="access_key=<R2_ACCESS_KEY_ID>" \
#      -backend-config="secret_key=<R2_SECRET_ACCESS_KEY>" \
#      -backend-config="endpoints={s3=\"https://<CLOUDFLARE_ACCOUNT_ID>.r2.cloudflarestorage.com\"}"
#
# Or create a backend.tfvars file (gitignored) with:
#   access_key = "your-r2-access-key-id"
#   secret_key = "your-r2-secret-access-key"
#   endpoints  = { s3 = "https://<account-id>.r2.cloudflarestorage.com" }
#
# Then run: terraform init -backend-config=backend.tfvars

# Using local backend for simplicity. State file lives in this directory.
# Switch back to the S3/R2 backend above for team/CI use.
terraform {
  backend "local" {
    path = "terraform.tfstate"
  }
}
