import * as cdk from "aws-cdk-lib";
import { Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as s3 from "aws-cdk-lib/aws-s3";
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

    const vpc = new ec2.Vpc(this, "cacheflow-vpc", {
      maxAzs: 3,
      subnetConfiguration: [
        // This is where database server resides.
        {
          name: `rds-subnet-${props.environment}`,
          cidrMask: 24,
          subnetType: ec2.SubnetType.PUBLIC,
        },
      ],
    });

    /******************** RDS MySql Database ********************/

    // const dbInstance = new rds.DatabaseCluster(this, "cacheflow-db-cluster", {
    //   engine: rds.DatabaseClusterEngine.auroraMysql({
    //     version: rds.AuroraMysqlEngineVersion.VER_5_7_12,
    //   }),
    //   defaultDatabaseName: "cacheflow",
    //   instanceProps: {
    //     vpc,
    //     vpcSubnets: {
    //       subnetType: ec2.SubnetType.PUBLIC,
    //     },
    //     instanceType: ec2.InstanceType.of(
    //       ec2.InstanceClass.T3,
    //       props.environment === "prod"
    //         ? ec2.InstanceSize.MEDIUM
    //         : ec2.InstanceSize.MEDIUM
    //     ),
    //   },
    //   credentials: rds.Credentials.fromGeneratedSecret("clusteradmin"),
    //   clusterIdentifier: `cacheflow-db-cluster-${props.environment}`,
    //   removalPolicy:
    //     props.environment === "prod"
    //       ? RemovalPolicy.RETAIN
    //       : RemovalPolicy.SNAPSHOT,
    // });
    // dbInstance.connections.allowDefaultPortFromAnyIpv4();

    // new CfnOutput(this, "credentials-secret-arn", {
    //   value: dbInstance.secret?.secretArn!,
    // });

    /******************** EC2 Instance for Frontend ********************/

    const ec2SecurityGroup = new ec2.SecurityGroup(this, "ec2-sg", {
      vpc,
      securityGroupName: `cacheflow-ec2-sg-${props.environment}`,
      description: "Allow SSH access to EC2 instances from anywhere.",
      allowAllOutbound: true,
    });
    ec2SecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      "Allow public SSH access."
    );

    const keyPair = new ec2.CfnKeyPair(this, "web-app-keypair", {
      keyName: `cacheflow-app-ec2-keypair`,
    });

    const ec2Instance = new ec2.Instance(this, "web-app-ec2-instance", {
      instanceName: `cacheflow-webapp-${props.environment}-instance`,
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
      "Allow public access to the web app."
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

    cdk.Tags.of(this).add("Example", "Deploy-Webapp-EC2-CDK-Script");
  }
}
