output "receiver_service_id" {
  value = fastly_service_compute.receiver.id
}

output "receiver_draft_version" {
  value = fastly_service_compute.receiver.cloned_version
}

output "trigger_service_id" {
  value = fastly_service_vcl.trigger.id
}

output "trigger_draft_version" {
  value = fastly_service_vcl.trigger.cloned_version
}

output "kv_store_id" {
  value = fastly_kvstore.tick_state.id
}

output "secret_store_id" {
  value = fastly_secretstore.tick_secrets.id
}

output "receiver_probe_url" {
  value = "https://${var.receiver_host}/__tick/probe"
}
