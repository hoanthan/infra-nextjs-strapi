#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import {StrapiStack} from '../lib/strapi';
import {StackProps} from "aws-cdk-lib";
import {NextjsStack} from "../lib/nextjs";

const commonVpcId = 'vpc-0c92b6779493dfa0c'

const commonStackProps: Partial<StackProps> = {
    env: {
        account: process.env.CDK_DEFAULT_ACCOUNT,
        region: process.env.CDK_DEFAULT_REGION
    },
}

const app = new cdk.App();
new StrapiStack(app, 'strapi', {
    ...commonStackProps,
    vpcId: commonVpcId
});

new NextjsStack(app, 'nextjs', {
    ...commonStackProps,
    vpcId: commonVpcId
})
