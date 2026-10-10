variable "name_prefix" {
  description = "Prefix for new services and stores; store-name changes require replacement."
  type        = string
  default     = "fastly-tick"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,39}$", var.name_prefix))
    error_message = "Use 1–40 lowercase letters, digits or hyphens, starting with a letter."
  }
}

variable "receiver_host" {
  description = "DNS hostname assigned to the Compute receiver, with working public TLS before trigger activation."
  type        = string

  validation {
    condition     = length(var.receiver_host) <= 253 && can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", var.receiver_host))
    error_message = "Use a lowercase DNS hostname without a scheme, path or port."
  }
}

variable "trigger_host" {
  description = "Distinct DNS hostname assigned to the dedicated VCL trigger."
  type        = string

  validation {
    condition     = length(var.trigger_host) <= 253 && can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", var.trigger_host))
    error_message = "Use a lowercase DNS hostname without a scheme, path or port."
  }
}

variable "worker_host" {
  description = "Existing external worker hostname for the compiled uptime backend; reconcile the literal fetch origin before building."
  type        = string

  validation {
    condition     = length(var.worker_host) <= 253 && can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", var.worker_host))
    error_message = "Use a lowercase DNS hostname without a scheme, path or port."
  }
}

variable "tick_probe_token" {
  description = "Receiver TICK_PROBE_TOKEN, inserted into the trigger health check. Sensitive in plans but retained in state/service configuration."
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^[!-~]{32,256}$", var.tick_probe_token))
    error_message = "Supply a dedicated 32–256 character printable ASCII token without whitespace."
  }
}

variable "receiver_package" {
  description = "Optional path to the reviewed Fastly .tar.gz package; null provisions the receiver without uploading code."
  type        = string
  default     = null

  validation {
    condition     = var.receiver_package == null ? true : can(regex("\\.tar\\.gz$", var.receiver_package)) && fileexists(var.receiver_package)
    error_message = "Use null or an existing Fastly .tar.gz package path, preferably absolute."
  }
}

variable "activate_receiver" {
  description = "Activate the receiver's reviewed package/configuration; default is an inactive draft."
  type        = bool
  default     = false
}

variable "activate_trigger" {
  description = "Activate the trigger only after the receiver's authenticated TLS smoke; default is an inactive draft."
  type        = bool
  default     = false
}
