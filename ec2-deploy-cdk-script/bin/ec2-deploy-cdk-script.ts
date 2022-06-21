#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { Ec2DeployCdkScriptStack } from "../lib/ec2-deploy-cdk-script-stack";
import * as dotenv from "dotenv";

dotenv.config();
const ENV = process.env.ENV as "dev" | "prod";

const app = new cdk.App();
new Ec2DeployCdkScriptStack(app, "Ec2DeployCdkScriptStack", {
  environment: ENV,
});
