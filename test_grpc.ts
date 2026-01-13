import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
// import { existsSync } from "https://deno.land/std/fs/mod.ts";

// process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

// 1. Define a minimal Proto file for the demo service
const PROTO_PATH = "./eliza.proto";
// const PROTO_SOURCE = `
// syntax = "proto3";
// package connectrpc.eliza.v1;
// service ElizaService {
//   rpc Say(SayRequest) returns (SayResponse) {}
// }
// message SayRequest {
//   string sentence = 1;
// }
// message SayResponse {
//   string sentence = 1;
// }
// `;

// 2. Write the proto file to disk if it doesn't exist
// if (!existsSync(PROTO_PATH)) {
//   Deno.writeTextFileSync(PROTO_PATH, PROTO_SOURCE);
//   console.log("✅ Created temporary 'eliza.proto' file.");
// }

// 3. Load the Proto definition
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
const protoDescriptor = grpc.loadPackageDefinition(packageDefinition);
// @ts-ignore: Dynamic loading makes types tricky, ignoring for simple test
const elizaService = protoDescriptor.connectrpc.eliza.v1.ElizaService;

// 4. Create the Client (connecting to the public demo server)
console.log("🔄 Connecting to demo.connectrpc.com:443...");
const client = new elizaService(
  "demo.connectrpc.com:443",
  grpc.credentials.createSsl()
);

// 5. Make a Request
client.Say({ sentence: "Hello from Deno!" }, (err: any, response: any) => {
  if (err) {
    console.error("❌ Connection Failed:", err);
    // Deno.exit(1);
  } else {
    console.log("✅ Success! Server replied:", response.sentence);
    // Deno.exit(0);
  }
});