# Mock plans exercise activation and loop guards without Fastly credentials/API calls.
mock_provider "fastly" {}

variables {
  receiver_host    = "tick.example.com"
  trigger_host     = "trigger.example.com"
  worker_host      = "uptime.example.com"
  tick_probe_token = "fixture-probe-token-not-a-credential"
}

run "bootstrap_drafts" {
  command = plan

  assert {
    condition     = !fastly_service_compute.receiver.activate && !fastly_service_vcl.trigger.activate
    error_message = "Bootstrap must leave both service versions inactive."
  }
  assert {
    condition     = length(fastly_service_compute.receiver.package) == 0
    error_message = "Bootstrap must not upload a package unless one is supplied."
  }
}

run "receiver_activation_requires_package" {
  command = plan
  variables {
    activate_receiver = true
  }
  expect_failures = [fastly_service_compute.receiver]
}

run "trigger_requires_receiver_activation" {
  command = plan
  variables {
    activate_trigger = true
  }
  expect_failures = [fastly_service_vcl.trigger]
}

run "trigger_cannot_probe_itself" {
  command = plan
  variables {
    trigger_host = "tick.example.com"
  }
  expect_failures = [fastly_service_vcl.trigger]
}

run "worker_cannot_call_receiver" {
  command = plan
  variables {
    worker_host = "tick.example.com"
  }
  expect_failures = [fastly_service_compute.receiver]
}

run "reject_weak_probe_token" {
  command = plan
  variables {
    tick_probe_token = "short"
  }
  expect_failures = [var.tick_probe_token]
}
