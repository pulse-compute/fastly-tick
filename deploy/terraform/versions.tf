terraform {
  required_version = ">= 1.9.0, < 2.0.0"

  required_providers {
    fastly = {
      source  = "fastly/fastly"
      version = "9.8.0"
    }
  }
}

# Authentication comes from FASTLY_API_KEY, not a committed variable or file.
provider "fastly" {}
