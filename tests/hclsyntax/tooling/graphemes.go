// Development-only extraction of the complete upstream Unicode grapheme table.
package main

import (
 "encoding/json"
 "go/ast"
 "go/parser"
 "go/token"
 "os"
 "strconv"
)

func bytesOf(expr ast.Expr) []byte {
 literal,ok:=expr.(*ast.CompositeLit);if !ok{panic("expected byte literal")}
 result:=make([]byte,0,len(literal.Elts))
 for _,item:=range literal.Elts {number,ok:=item.(*ast.BasicLit);if !ok{panic("nonconstant byte")};value,err:=strconv.ParseUint(number.Value,0,8);if err!=nil{panic(err)};result=append(result,byte(value))}
 return result
}
func main() {
 if len(os.Args)!=3||os.Args[1]!="--"{panic("usage: graphemes.go -- upstream/textseg/tables_test.go")}
 file,err:=parser.ParseFile(token.NewFileSet(),os.Args[2],nil,0);if err!=nil{panic(err)}
 var rows []map[string]any
 ast.Inspect(file,func(node ast.Node)bool{
  declaration,ok:=node.(*ast.ValueSpec);if !ok||len(declaration.Names)!=1||declaration.Names[0].Name!="unicodeGraphemeTests"{return true}
  table:=declaration.Values[0].(*ast.CompositeLit)
  for _,entry:=range table.Elts {
   row:=map[string]any{}
   for _,item:=range entry.(*ast.CompositeLit).Elts {
    field:=item.(*ast.KeyValueExpr);name:=field.Key.(*ast.Ident).Name
    if name=="input"{row["source"]=bytesOf(field.Value)}else if name=="output"{output:=[][]byte{};for _,part:=range field.Value.(*ast.CompositeLit).Elts{output=append(output,bytesOf(part))};row["clusters"]=output}else{panic("unknown table field")}
   }
   rows=append(rows,row)
  }
  return false
 })
 if len(rows)==0{panic("upstream grapheme table missing")}
 if err:=json.NewEncoder(os.Stdout).Encode(rows);err!=nil{panic(err)}
}
