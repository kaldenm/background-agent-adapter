variable "api_key" {
  description = "Daytona REST API key"
  type        = string
  sensitive   = true
}

variable "api_url" {
  description = "Daytona REST API base URL"
  type        = string
}

variable "organization_id" {
  description = "Optional Daytona organization id for org-scoped API keys"
  type        = string
  default     = ""
}

variable "target" {
  description = "Optional Daytona target name"
  type        = string
  default     = ""
}

variable "snapshot_name" {
  description = "Name of the operator-owned Daytona snapshot used for fresh sandbox creation"
  type        = string
}

variable "snapshot_mode" {
  description = "How Terraform treats the Daytona snapshot: manual uses an existing snapshot, verify runs non-mutating checks, build creates/recreates it"
  type        = string
  default     = "manual"

  validation {
    condition     = contains(["manual", "verify", "build"], var.snapshot_mode)
    error_message = "snapshot_mode must be one of: manual, verify, build."
  }
}

variable "deploy_path" {
  description = "Path to packages/daytona-infra"
  type        = string
}

variable "source_hash" {
  description = "Hash of snapshot source files; used to rerun the configured snapshot mode when changed"
  type        = string
}
