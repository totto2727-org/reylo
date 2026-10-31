// Copyright IBM Corp. 2014, 2025
// SPDX-License-Identifier: MPL-2.0
// Development-only instrumentation of the pinned upstream tests.
package main

import (
 "bytes"
 "encoding/json"
 "fmt"
 "go/ast"
 "go/format"
 "go/parser"
 "go/token"
 "os"
 "path/filepath"
)

func main() {
 if len(os.Args) != 4 { panic("usage: instrument.go UPSTREAM WORK HOOKS") }
 upstream, work, hooks := os.Args[1], os.Args[2], os.Args[3]
 if err := os.MkdirAll(work, 0755); err != nil { panic(err) }
 replacements := map[string]string{}
 functions := map[string]bool{"ParseConfig":true,"ParseExpression":true,"ParseTemplate":true,"LexConfig":true,"LexExpression":true,"LexTemplate":true,"scanTokens":true,"scanStringLit":true,"ValidIdentifier":true}
 files := []string{"parser_test.go","scan_tokens_test.go","scan_string_lit_test.go","token_test.go","public_test.go","expression_test.go","expression_template_test.go"}
 manifest := map[string][]string{}
 for _, filename := range files {
  original := filepath.Join(upstream,"hclsyntax",filename)
  fset := token.NewFileSet()
  tree, err := parser.ParseFile(fset,original,nil,parser.ParseComments)
  if err != nil { panic(err) }
  for _, declaration := range tree.Decls {
   function, ok := declaration.(*ast.FuncDecl)
   if !ok || len(function.Name.Name)<4 || function.Name.Name[:4]!="Test" {continue}
   manifest[filename]=append(manifest[filename],function.Name.Name)
   ast.Inspect(function.Body,func(n ast.Node)bool{
    call,ok:=n.(*ast.CallExpr); if !ok{return true}
    name,ok:=call.Fun.(*ast.Ident);if !ok || !functions[name.Name]{return true}
    name.Name="reyloOracle"+name.Name
    call.Args=append(call.Args,&ast.CallExpr{Fun:&ast.SelectorExpr{X:ast.NewIdent("t"),Sel:ast.NewIdent("Name")}})
    return true
   })
  }
  var output bytes.Buffer
  if err:=format.Node(&output,fset,tree);err!=nil{panic(err)}
  destination:=filepath.Join(work,filename)
  if err:=os.WriteFile(destination,output.Bytes(),0644);err!=nil{panic(err)}
  replacements[original]=destination
 }
 replacements[filepath.Join(upstream,"hclsyntax","z_reylo_oracle_test.go")]=hooks
 data,_:=json.MarshalIndent(map[string]any{"Replace":replacements},"","  ")
 if err:=os.WriteFile(filepath.Join(work,"overlay.json"),data,0644);err!=nil{panic(err)}
 data,_=json.MarshalIndent(manifest,"","  ")
 if err:=os.WriteFile(filepath.Join(work,"functions.json"),data,0644);err!=nil{panic(err)}
 fmt.Println(filepath.Join(work,"overlay.json"))
}
