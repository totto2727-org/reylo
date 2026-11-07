schema "main" {}

table "users" {
  schema = schema.main
  column "id" {
    type = integer
    null = false
  }
  column "name" {
    type = text
    null = false
  }
  primary_key {
    columns = [column.id]
  }
}
