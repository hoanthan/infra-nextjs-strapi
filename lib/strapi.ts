import { Construct } from 'constructs';
import {CfnOutput, Duration, Stack, StackProps} from "aws-cdk-lib";
import {
  CloudFormationInit, InitConfig,
  InstanceClass, InstanceSize,
  InstanceType,
  KeyPair,
  LaunchTemplate,
  Peer,
  Port,
  SecurityGroup,
  UserData,
  Vpc
} from "aws-cdk-lib/aws-ec2";
import {startCase} from "lodash";
import {ManagedPolicy, PolicyDocument, PolicyStatement, Role, ServicePrincipal} from "aws-cdk-lib/aws-iam";
import {
  AsgCapacityProvider,
  AwsLogDriver,
  Cluster,
  ContainerImage, Ec2Service,
  Ec2TaskDefinition,
  EcsOptimizedImage, Protocol
} from "aws-cdk-lib/aws-ecs";
import {AutoScalingGroup, HealthCheck, Monitoring, Signals, TerminationPolicy} from "aws-cdk-lib/aws-autoscaling";
import {LogGroup} from "aws-cdk-lib/aws-logs";
import {Repository} from "aws-cdk-lib/aws-ecr";

interface StrapiStackProps extends StackProps {
  vpcId: string;
}

export class StrapiStack extends Stack {
  protected getConstructId = (name: string) => `stack-${this.id}-${startCase(name)}`;

  constructor(private readonly  scope: Construct, private  readonly id: string, props: StrapiStackProps) {
    super(scope, id, props);

    // vpc
    const vpc = Vpc.fromLookup(this, 'vpc', {
      vpcId: props.vpcId
    })

    // Create a security group
    const securityGroup = new SecurityGroup(this, this.getConstructId('sg'), {
      vpc,
      description: 'Strapi Security Group',
      allowAllOutbound: true,
      securityGroupName: this.getConstructId('sg'),
    });

    securityGroup.addIngressRule(Peer.anyIpv4(), Port.tcp(22));
    securityGroup.addIngressRule(Peer.anyIpv4(), Port.tcp(80));
    securityGroup.addIngressRule(Peer.anyIpv4(), Port.tcp(443));
    securityGroup.addIngressRule(Peer.anyIpv4(), Port.tcp(1337));

    // keypair
    const keyPair = new KeyPair(this, this.getConstructId('keyPair'), {
      keyPairName: this.getConstructId('keyPair'),
    })

    // Create a role for the EC2 instance to assume.  This role will allow the instance to put log events to CloudWatch Logs
    const role = new Role(this, this.getConstructId('role'), {
      roleName: this.getConstructId('role'),
      assumedBy: new ServicePrincipal('ec2.amazonaws.com'),
      inlinePolicies: {
        ['RetentionPolicy']: new PolicyDocument({
          statements: [
            new PolicyStatement({
              resources: ['*'],
              actions: ['logs:PutRetentionPolicy'],
            }),
          ],
        }),
      },
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
        ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSAppRunnerServicePolicyForECRAccess'),
        ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonEC2ContainerServiceforEC2Role'),
      ],
    });

    // ECS Cluster
    const cluster = new Cluster(this, this.getConstructId('cluster'), {
      vpc,
      clusterName: 'nextjs_strapi',
    });

    // User Data
    const userData = UserData.forLinux();
    userData.addCommands(
        '#!/bin/bash',
        'yum update -y',
        'yum install -y aws-cfn-bootstrap', // Install cfn-signal
        `/opt/aws/bin/cfn-signal --stack ${Stack.of(this).stackName} --resource ${this.getConstructId('asg')} --region us-east-1 --exit-code $?` // send signal to cfn
    )

    const launchTemplate = new LaunchTemplate(this, this.getConstructId('instance'), {
      launchTemplateName: 'strapi',
      securityGroup,
      instanceType: InstanceType.of(InstanceClass.T2, InstanceSize.MICRO),
      keyPair,
      role,
      machineImage: EcsOptimizedImage.amazonLinux2023(),
      userData,
    })

    const autoScalingGroup = new AutoScalingGroup(this, this.getConstructId('asg'), {
      autoScalingGroupName: this.getConstructId('asg'),
      vpc,
      desiredCapacity: 1,
      minCapacity: 1,
      maxCapacity: 1,
      terminationPolicies: [TerminationPolicy.OLDEST_INSTANCE],
      instanceMonitoring: Monitoring.BASIC,
      init: CloudFormationInit.fromConfigSets({
        configSets: {
          default: ['config']
        },
        configs: {
          config: new InitConfig([
            // InitCommand.shellCommand('sudo yum update -y'),
            // InitCommand.shellCommand('sudo amazon-linux-extras install docker'),
            // InitCommand.shellCommand('sudo service docker start'),
            // InitCommand.shellCommand('sudo usermod -a -G docker ec2-user'),
          ])
        }
      }),
      initOptions: {
        includeUrl: true,
        includeRole: true,
        printLog: true,
      },
      launchTemplate,
      healthCheck: HealthCheck.ec2({
        grace: Duration.minutes(5)
      }),
      signals: Signals.waitForAll({timeout: Duration.minutes(5)}),
    })

    cluster.addAsgCapacityProvider(
        new AsgCapacityProvider(this, this.getConstructId('AsgCapacityProvider'), {
          autoScalingGroup,
          enableManagedTerminationProtection: false
        })
    )

    // Cloudwatch
    const logging = new AwsLogDriver({ streamPrefix: 'strapi', logGroup: LogGroup.fromLogGroupName(this, this.getConstructId('logGroup'), 'strapi') });

    const taskDef = new Ec2TaskDefinition(this, 'strapi', {
      family: 'strapi',
    })

    const repo = Repository.fromRepositoryName(this, this.getConstructId('repo'), 'strapi-sample');

    const container = taskDef.addContainer(this.getConstructId('strapiContainer'), {
      image: ContainerImage.fromEcrRepository(repo),
      cpu: 256,
      memoryReservationMiB: 256,
      portMappings: [{
        containerPort: 1337,
        hostPort: 80,
        protocol: Protocol.TCP
      }],
      logging: logging,
      containerName: 'strapi',
      healthCheck: {
        command: ['CMD-SHELL', 'curl -f http://localhost:1337 || exit 1'],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        retries: 2,
        startPeriod: Duration.seconds(60),
      },
    });

    const service = new Ec2Service(this, this.getConstructId('strapi'), {
      cluster: cluster,
      taskDefinition: taskDef,
      desiredCount: 1,
      serviceName: this.getConstructId('service'),
      minHealthyPercent: 0,
      maxHealthyPercent: 100
    });

    new CfnOutput(this, 'Service Name', {
      value: service.serviceName
    })
  }
}
