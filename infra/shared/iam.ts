export const LAMBDA_ASSUME_ROLE_POLICY = Object.freeze({
  Version: "2012-10-17",
  Statement: [
    {
      Action: "sts:AssumeRole",
      Effect: "Allow",
      Principal: { Service: "lambda.amazonaws.com" },
    },
  ],
});

// Execution role for a Lambda in this stack (the .NET API, the Python MCP server): CloudWatch
// Logs only. Each function gets its own role so neither inherits a grant added for the other.
// No VPC, so no NAT — functions reach Neon, Clerk, and each other over the public internet
// with TLS. (This is the single biggest "silent billing" avoidance in the stack.)
export function createLambdaExecutionRole(roleName: string, logsAttachmentName: string) {
  const role = new aws.iam.Role(roleName, {
    assumeRolePolicy: JSON.stringify(LAMBDA_ASSUME_ROLE_POLICY),
  });
  new aws.iam.RolePolicyAttachment(logsAttachmentName, {
    role: role.name,
    policyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
  });
  return role;
}
