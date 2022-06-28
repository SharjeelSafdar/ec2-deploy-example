import * as cdk from "aws-cdk-lib";
import { Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as elbv2Targets from "aws-cdk-lib/aws-elasticloadbalancingv2-targets";
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
    ec2SecurityGroup.connections.allowFromAnyIpv4(
      ec2.Port.tcp(22),
      "Allow public SSH access to the web app instance."
    );
    ec2SecurityGroup.connections.allowFromAnyIpv4(
      ec2.Port.tcp(80),
      "Allow public HTTP access to the web app instance."
    );
    ec2SecurityGroup.connections.allowFromAnyIpv4(
      ec2.Port.tcp(443),
      "Allow public HTTPS access to the web app instance."
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
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC,
      },
    });
    ec2Instance.addUserData(
      "#!/bin/bash",
      "sudo yum update -y",
      // "sudo amazon-linux-extras install nginx1 -y",
      // "sudo systemctl enable nginx",
      // "sudo systemctl start nginx",

      "sudo yum -y install ruby",
      "sudo yum -y install wget",
      "cd /home/ec2-user",
      "wget https://aws-codedeploy-us-east-1.s3.us-east-1.amazonaws.com/latest/install",
      "sudo chmod +x ./install",
      "sudo ./install auto",
      "sudo yum install -y python-pip",
      "sudo pip install awscli"
    );

    const certificate = acm.Certificate.fromCertificateArn(
      this,
      "webapp-certificate",
      "arn:aws:acm:us-east-1:450887467397:certificate/bfcf693e-a72b-4ac7-acb3-d5b9281f59e7"
    );

    const elasticIp = new ec2.CfnEIP(this, "elastic-ip-for-ec2", {
      instanceId: ec2Instance.instanceId,
    });

    const appLoadBalancer = new elbv2.ApplicationLoadBalancer(
      this,
      "load-balancer",
      {
        vpc,
        internetFacing: true,
        loadBalancerName: `Webapp-Load-Balancer`,
        securityGroup: ec2SecurityGroup,
        vpcSubnets: {
          subnetType: ec2.SubnetType.PUBLIC,
        },
      }
    );

    const targetGroup = new elbv2.ApplicationTargetGroup(this, "webapp-tg", {
      vpc,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.INSTANCE,
      targets: [new elbv2Targets.InstanceTarget(ec2Instance)],
      healthCheck: {
        protocol: elbv2.Protocol.HTTP,
      },
    });

    const httpListener = appLoadBalancer.addListener(
      "listner-to-webapp-instance-http",
      {
        protocol: elbv2.ApplicationProtocol.HTTP,
        open: true,
      }
    );
    httpListener.addAction("http-listener-action", {
      action: elbv2.ListenerAction.redirect({
        permanent: true,
        port: "443",
        protocol: "https",
      }),
    });

    const httpsListener = appLoadBalancer.addListener(
      "listner-to-webapp-instance",
      {
        certificates: [certificate],
        protocol: elbv2.ApplicationProtocol.HTTPS,
        open: true,
      }
    );
    httpsListener.addTargetGroups("https-listener-target", {
      targetGroups: [targetGroup],
    });

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

    // Grant EC2 instance to read files from artifacts bucket.
    webappDeployPipeline.artifactBucket.grantRead(ec2Instance);
    // Create artifacts in the bucket for storing source code and built app.
    const sourceCodeArtifact = new codePipeline.Artifact("SourceCode");
    const builtAppArtifact = new codePipeline.Artifact("BuiltApp");

    // Stage 1: Checkout web app code from repo.
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

    // Stage 2: Build web app with AWS CodeDeploy.
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

    // Stage 3: Deploy the built web app to EC2 instance(s).
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

    cdk.Tags.of(this).add("Example", "Deploy-Webapp-EC2-CDK-Script");
  }
}
