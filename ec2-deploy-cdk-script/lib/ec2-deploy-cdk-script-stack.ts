import * as cdk from "aws-cdk-lib";
import { Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as codeBuild from "aws-cdk-lib/aws-codebuild";
import * as codeDeploy from "aws-cdk-lib/aws-codedeploy";
import * as codePipeline from "aws-cdk-lib/aws-codepipeline";
import * as codePipelineActions from "aws-cdk-lib/aws-codepipeline-actions";

interface Ec2DeployCdkScriptStackProps extends StackProps {
  environment: "dev" | "prod";
}

export class Ec2DeployCdkScriptStack extends Stack {
  constructor(
    scope: Construct,
    id: string,
    props: Ec2DeployCdkScriptStackProps
  ) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, "my-vpc", {
      maxAzs: 3,
      subnetConfiguration: [
        {
          name: `public-subnet-${props.environment}`,
          cidrMask: 24,
          subnetType: ec2.SubnetType.PUBLIC,
        },
      ],
    });

    /******************** EC2 Instance for Frontend ********************/

    const ec2SecurityGroup = new ec2.SecurityGroup(this, "ec2-sg", {
      vpc,
      securityGroupName: `ec2-sg-${props.environment}`,
      allowAllOutbound: true,
    });
    ec2SecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      "Allow public access."
    );

    const keyPair = new ec2.CfnKeyPair(this, "web-app-keypair", {
      keyName: `webapp-ec2-keypair`,
    });

    const ec2Instance = new ec2.Instance(this, "web-app-ec2-instance", {
      instanceName: `webapp-${props.environment}-instance`,
      vpc,
      keyName: keyPair.keyName,
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T2,
        props.environment === "prod"
          ? ec2.InstanceSize.MICRO
          : ec2.InstanceSize.MICRO
      ),
      machineImage: ec2.MachineImage.latestAmazonLinux({
        generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2,
      }),
      securityGroup: ec2SecurityGroup,
    });
    ec2Instance.connections.allowFromAnyIpv4(
      ec2.Port.tcp(22),
      "Allow public access to the web app instance."
    );
    ec2Instance.connections.allowFromAnyIpv4(
      ec2.Port.tcp(80),
      "Allow public access to the web app instance."
    );
    ec2Instance.addUserData(
      "#!/bin/bash",
      "sudo yum -y update",
      "sudo yum -y install ruby",
      "sudo yum -y install wget",
      "cd /home/ec2-user",
      "wget https://aws-codedeploy-us-east-1.s3.us-east-1.amazonaws.com/latest/install",
      "sudo chmod +x ./install",
      "sudo ./install auto",
      "sudo yum install -y python-pip",
      "sudo pip install awscli"
    );

    /******************** CI/CD Pipeline ********************/

    const webappDeployPipeline = new codePipeline.Pipeline(
      this,
      "webapp-deploy-pipeline",
      {
        pipelineName: "WebappDeployPipeline",
        crossAccountKeys: false,
        restartExecutionOnUpdate: true,
      }
    );

    const sourceCodeArtifact = new codePipeline.Artifact("SourceCode");
    const builtAppArtifact = new codePipeline.Artifact("BuiltApp");

    webappDeployPipeline.addStage({
      stageName: "GetSourceCode",
      actions: [
        new codePipelineActions.GitHubSourceAction({
          actionName: "CheckoutGithubSource",
          owner: "SharjeelSafdar",
          repo: "ec2-deploy-example",
          branch: "main",
          oauthToken: cdk.SecretValue.secretsManager(
            process.env.GIT_OAUTH_TOKEN_SECRET_ARN!
          ),
          output: sourceCodeArtifact,
        }),
      ],
    });

    const buildProject = new codeBuild.PipelineProject(this, "BuildCdkStack", {
      projectName: "BuildWebApp",
      buildSpec: codeBuild.BuildSpec.fromObject({
        version: "0.2",
        phases: {
          install: {
            "runtime-versions": {
              nodejs: 14,
            },
            commands: ["cd sample-react-app/", "npm i"],
          },
          build: {
            commands: [
              "npm run build",
              "cp ../ec2-deploy-cdk-script/ec2/appspec.yml ./build/",
              "cp -r ../ec2-deploy-cdk-script/ec2/scripts/ ./build/",
              "cd ./build",
              "ls",
            ],
          },
        },
        artifacts: {
          "base-directory": "sample-react-app/build",
          files: ["**/*"],
        },
      }),
      environment: {
        buildImage: codeBuild.LinuxBuildImage.STANDARD_5_0,
      },
    });

    webappDeployPipeline.addStage({
      stageName: "BuildApp",
      actions: [
        new codePipelineActions.CodeBuildAction({
          actionName: "BuildApp",
          project: buildProject,
          input: sourceCodeArtifact,
          outputs: [builtAppArtifact],
        }),
      ],
    });

    const serverApplication = new codeDeploy.ServerApplication(
      this,
      "ec2-server-application",
      {
        applicationName: "EC2-Server-Application",
      }
    );

    const deploymentGroup = new codeDeploy.ServerDeploymentGroup(
      this,
      "deployment-group",
      {
        deploymentGroupName: "Webapp-Deployment-Group",
        application: serverApplication,
        ec2InstanceTags: new codeDeploy.InstanceTagSet({
          Example: ["Deploy-Webapp-EC2-CDK-Script"],
        }),
        deploymentConfig: codeDeploy.ServerDeploymentConfig.ONE_AT_A_TIME,
        installAgent: true,
      }
    );

    webappDeployPipeline.addStage({
      stageName: "DeployWebappToEC2",
      actions: [
        new codePipelineActions.CodeDeployServerDeployAction({
          actionName: "DeployWebAppToEC2",
          input: builtAppArtifact,
          deploymentGroup,
        }),
      ],
    });

    ec2Instance.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["s3:*"],
        resources: [`arn:aws:s3:::${builtAppArtifact.bucketName}`],
      })
    );

    cdk.Tags.of(this).add("Example", "Deploy-Webapp-EC2-CDK-Script");
  }
}
