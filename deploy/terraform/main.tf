resource "fastly_kvstore" "tick_state" {
  name          = "${var.name_prefix}-state"
  force_destroy = false

  lifecycle {
    prevent_destroy = true
  }
}

resource "fastly_secretstore" "tick_secrets" {
  name = "${var.name_prefix}-secrets"

  lifecycle {
    prevent_destroy = true
  }
}

data "fastly_package_hash" "receiver" {
  count    = var.receiver_package == null ? 0 : 1
  filename = var.receiver_package
}

resource "fastly_service_compute" "receiver" {
  name          = "${var.name_prefix}-receiver"
  activate      = var.activate_receiver
  stage         = false
  force_destroy = false

  domain {
    name = var.receiver_host
  }

  resource_link {
    name        = "tick_state"
    resource_id = fastly_kvstore.tick_state.id
  }

  resource_link {
    name        = "tick_secrets"
    resource_id = fastly_secretstore.tick_secrets.id
  }

  backend {
    name                  = "uptime"
    address               = var.worker_host
    port                  = 443
    use_ssl               = true
    ssl_check_cert        = true
    ssl_cert_hostname     = var.worker_host
    ssl_sni_hostname      = var.worker_host
    override_host         = var.worker_host
    connect_timeout       = 500
    first_byte_timeout    = 1000
    between_bytes_timeout = 1000
  }

  dynamic "package" {
    for_each = var.receiver_package == null ? [] : [var.receiver_package]
    content {
      filename         = package.value
      source_code_hash = data.fastly_package_hash.receiver[0].hash
    }
  }

  lifecycle {
    precondition {
      condition     = !var.activate_receiver || var.receiver_package != null
      error_message = "Receiver activation requires a reviewed Fastly package."
    }
    precondition {
      condition     = var.receiver_host != var.worker_host
      error_message = "The worker backend must not point back to the receiver hostname."
    }
  }
}

# A separate default-VCL service owns recurring backend health checks.
resource "fastly_service_vcl" "trigger" {
  name          = "${var.name_prefix}-trigger"
  activate      = var.activate_trigger
  stage         = false
  force_destroy = false

  domain {
    name = var.trigger_host
  }

  healthcheck {
    name              = "tick_probe"
    host              = var.receiver_host
    path              = "/__tick/probe"
    method            = "GET"
    http_version      = "1.1"
    check_interval    = 15000
    timeout           = 5000
    expected_response = 200
    window            = 5
    threshold         = 3
    initial           = 3
    headers = [
      "x-tick-probe-token: ${var.tick_probe_token}",
      "x-tick-probe-kind: healthcheck",
    ]
  }

  backend {
    name                  = "tick_receiver"
    address               = var.receiver_host
    port                  = 443
    use_ssl               = true
    ssl_check_cert        = true
    ssl_cert_hostname     = var.receiver_host
    ssl_sni_hostname      = var.receiver_host
    override_host         = var.receiver_host
    healthcheck           = "tick_probe"
    connect_timeout       = 1000
    first_byte_timeout    = 5000
    between_bytes_timeout = 5000
  }

  depends_on = [fastly_service_compute.receiver]

  lifecycle {
    precondition {
      condition     = var.trigger_host != var.receiver_host && var.trigger_host != var.worker_host
      error_message = "Use a dedicated trigger hostname distinct from the receiver and worker."
    }
    precondition {
      condition     = !var.activate_trigger || var.activate_receiver
      error_message = "Activate and smoke-test the receiver before activating the trigger."
    }
  }
}
