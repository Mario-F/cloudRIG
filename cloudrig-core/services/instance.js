var AWS = require('aws-sdk');
var async = require('async');
var fs = require('fs');
var ursa = require('ursa');
var publicIp = require('public-ip');
var reporter = require('../helpers/reporter')();

var config;
var credentials;
var settings = {};
var iam;
var ec2;
var ssm;
var securityKeyPairPath = "cloudrig.pem";
var fleetRoleName = "cloudrig-spotfleet-4";
var ssmRoleName = "cloudrig-ssm-4";
var standardFilter = [{
	Name: 'tag:cloudrig',
	Values: ['true']
}];

function findFleetRole(cb) {

	iam.listRoles({}, function(err, data) {
		
		if (err) {
			cb(err); 
		} else  {
			for(var i = 0; i < data.Roles.length; i++) {
				
				if(data.Roles[i].RoleName == fleetRoleName) {
					cb(null, data.Roles[i]);
					return;
				}
			}
			cb(null);
		}
	});

}

function findSSMRole(cb) {

	var ret = {};

	async.series([

		(cb) => {

			iam.listRoles({}, function(err, data) {

				if (err) {
					cb(err);
					return;
				}

				data.Roles.forEach((role, i) => {

					if(role.RoleName == ssmRoleName) {

						ret.Role = role;

					}
					
				});

				cb(null);

			});

		},

		(cb) => {

			iam.listInstanceProfiles({}, function(err, data) {
				
				if (err) {
					cb(err);
					return;
				}

				data.InstanceProfiles.forEach((profile, i) => {

					if(profile.InstanceProfileName == ssmRoleName) {

						ret.InstanceProfile = profile;

					}
					
				});

				cb(null);

			});

		}

	], (err, results) => {

		if(err) {
			cb(err);
			return;
		}

		cb(null, ret);

	});	

}


function findAMI (cb) {

	var params = {
		Owners: ['self'],
		Filters: standardFilter
	}

	ec2.describeImages(params, function(err, data) {

		if (err) {
			cb(err); 
		} else {
			cb(null, data.Images[0]);
		}

	});

}

function findSecurityGroup(cb) {
	var params = {
		Filters: standardFilter
	};

	ec2.describeSecurityGroups(params, function(err, data) {
		
		if (err) {
			cb(err); 
		} else {
			cb(null, data.SecurityGroups[0]);
		}
		
	});
}


function findKeyPair (cb) {

	var params = {
		KeyNames: [
			"cloudrig"
		]
	};

	ec2.describeKeyPairs(params, function(err, data) {
		// Error if there are no keys
		// TODO: Warn if there's more than 1
		if (err) {
			cb(null, null); 
		} else {
			cb(null, data.KeyPairs[0]);
		}
		
	});
}

function getActiveInstances(cb) {

	var params = {
		Filters: standardFilter.concat([{
			Name: 'instance-state-name',
			Values: ['running']
		}])
	}

	ec2.describeInstances(params, function(err, data) {
		
		if (err) {
			cb(err); 
		} else {
			cb(null, data.Reservations[0] ? data.Reservations[0].Instances : []);
		}

	});

}

function findSpotFleetInstances(SpotFleetRequestId, cb) {
	
	var params = {
		SpotFleetRequestId: SpotFleetRequestId
	}

	ec2.describeSpotFleetInstances(params, function(err, data) {
		if (err) {
			cb(err); 
		} else {
			cb(null, data.ActiveInstances);
		}

	});

}

function getPendingInstances(cb) {

	var params = {
		Filters: standardFilter.concat([{
			Name: 'instance-state-name',
			Values: ['pending']
		}])
	}

	ec2.describeInstances(params, function(err, data) {
		
		if (err) {
			cb(err); 
		} else {
			cb(null, data.Reservations[0] ? data.Reservations[0].Instances : []);
		}

	});

}

function getShuttingDownInstances(cb) {

	var params = {
		Filters: standardFilter.concat([{
			Name: 'instance-state-name',
			Values: ['shutting-down']
		}])
	}

	ec2.describeInstances(params, function(err, data) {
		
		if (err) {
			cb(err); 
		} else {
			cb(null, data.Reservations[0] ? data.Reservations[0].Instances : []);
		}

	});

}

function createTags(resourceId, cb) {

	var params = {
		Resources: [resourceId], 
		Tags: [
			{
				Key: "cloudrig", 
				Value: "true"
			}
		]
	};
	
	ec2.createTags(params, function(err, data) {
		if (err) {
			reporter.report(err.stack, "error");
		} else {
			cb(data);
		}
	});

}

function createSecurityGroup(cb) {
	
	reporter.report("Creating security group...");
	
	publicIp.v4().then(function(ip) {

		var params = {
			Description: "CloudRig" + (+new Date()),
			GroupName: "CloudRig" + (+new Date())
		};

		ec2.createSecurityGroup(params, function(err, securityGroupData) {

			if (err) {

				reporter.report(err.stack, "error");

			} else {
				
				//http://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_AuthorizeSecurityGroupEgress.html
				var params = {
					GroupId: securityGroupData.GroupId, /* required */
					IpPermissions: [{
						FromPort: -1,
						ToPort: -1,
						IpProtocol: '-1',
						IpRanges: [
							{ CidrIp: ip + "/32" }
						]
					}]
				};

				reporter.report(params)
				
				ec2.authorizeSecurityGroupIngress(params, function (err, data) {

					if (err) {

						reporter.report(err.stack, "error");

					} else {
						reporter.report("Tagging...")
						createTags(securityGroupData.GroupId, cb)
					}

				});

			}
			
		});

	});
	
}


function createFleetRole(cb) {

	async.series([

		(cb) => {

			var policy = '{\
				"Version": "2012-10-17",\
				"Statement": {\
					"Effect": "Allow",\
					"Principal": {\
						"Service": "spotfleet.amazonaws.com"\
					},\
					"Action": "sts:AssumeRole"\
				}\
			}';

			reporter.report("Creating fleet role '" + fleetRoleName + "'...");

			iam.createRole({
				AssumeRolePolicyDocument: policy,
				Path: "/", 
				RoleName: fleetRoleName
			}, cb);

		},

		(cb) => {

			var policy = "arn:aws:iam::aws:policy/service-role/AmazonEC2SpotFleetRole";

			reporter.report("Attaching the policy '" + policy + "'...");
			
			iam.attachRolePolicy({
				PolicyArn: policy, 
				RoleName: fleetRoleName
			}, cb);

		}


	], cb);

}


function createSSMRole(cb) {
	
	async.series([

		(cb) => {

			var policy = '{\
				"Version": "2012-10-17",\
				"Statement": {\
					"Effect": "Allow",\
					"Principal": {\
						"Service": "ec2.amazonaws.com",\
						"Service": "ssm.amazonaws.com"\
					},\
					"Action": "sts:AssumeRole"\
				}\
			}';

			reporter.report("Creating SSM role '" + ssmRoleName + "'...");

			iam.createRole({
				AssumeRolePolicyDocument: policy,
				Path: "/", 
				RoleName: ssmRoleName
			}, () => {
				cb(null);
			})

		},

		(cb) => {

			var policy = "arn:aws:iam::aws:policy/service-role/AmazonEC2RoleforSSM";

			reporter.report("Attaching the policy '" + policy + "'...");

			iam.attachRolePolicy({
				PolicyArn: policy, 
				RoleName: ssmRoleName
			}, cb);

		},

		(cb) => {

			var policy = "arn:aws:iam::aws:policy/AmazonSNSFullAccess";

			reporter.report("Attaching the policy '" + policy + "'...");

			iam.attachRolePolicy({
				PolicyArn: policy, 
				RoleName: ssmRoleName
			}, cb);

		},

		(cb) => {

			reporter.report("Creating instance profile '" + ssmRoleName + "'...");

			iam.createInstanceProfile({
				InstanceProfileName: ssmRoleName
			}, cb);

		},

		(cb) => {

			reporter.report("Adding role '" + ssmRoleName + "' to instance profile '" + ssmRoleName + "'...");

			iam.addRoleToInstanceProfile({
				InstanceProfileName: ssmRoleName, 
				RoleName: ssmRoleName
			}, cb);

		}

	], cb);

}

function createKeyPair(cb) {
	
	var params = {
		KeyName: "cloudrig"
	};

	ec2.createKeyPair(params, function(err, data) {
		
		if (err) {

			reporter.report(err.stack, "error");
			cb("error");

		} else {

			cb(data);

		}

	});
	
}

function createImage(cb) {

	reporter.report("Creating image...");

	var params = {
		Name: 'cloudrig',
		SourceImageId: 'ami-f0d0d293',
		SourceRegion: 'ap-southeast-2'
	};

	ec2.copyImage(params, function(err, data) {

		if (err) {
			reporter.report(err.stack, "error");
			cb("error");
		} else {

			reporter.report("Waiting for image to become available...");

			ec2.waitFor('imageAvailable', {
				ImageIds: [data.ImageId]
			}, function() {

				reporter.report("Adding tags to '" + data.ImageId + "'...");
				createTags(data.ImageId, cb);

			});

		}

	});

}

function getPassword(instanceId, cb) {

	reporter.report("Getting password using private key '" + securityKeyPairPath + "'...")

	var pem = fs.readFileSync(securityKeyPairPath);
	var pkey = ursa.createPrivateKey(pem);

	ec2.getPasswordData({InstanceId: instanceId}, function (err, data) {

		if(err) {
			cb(err);
			return;
		}

		var password = pkey.decrypt(data.PasswordData, 'base64', 'utf8', ursa.RSA_PKCS1_PADDING);

		cb(null, password);

	});

}

function removeTags(resourceId, cb) {

	var params = {
		Resources: [resourceId], 
		Tags: [
			{
				Key: "cloudrig", 
				Value: "true"
			}
		]
	};
	
	ec2.deleteTags(params, function(err, data) {
		if (err) {
			reporter.report(err.stack, "error");
		} else {
			cb(data);
		}
	});

}

function updateImage(instanceId, amiId, cb) {
	
	var params = {
		InstanceId: instanceId,
		Name: 'cloudrig-' + new Date().getTime(),
		NoReboot: true
	};

	reporter.report("Creating image...");

	ec2.createImage(params, function(err, data) {
		
		if (err) {
			reporter.report(err.stack, "error");
		} else {
			
			reporter.report("Waiting for image to be available...");

			ec2.waitFor('imageAvailable', {
				ImageIds: [data.ImageId]
			}, function() {
				
				reporter.report("Removing tag from " + amiId);

				removeTags(amiId, function() {

					reporter.report("Adding tag to " + data.ImageId);

					createTags(data.ImageId, function() {

						cb(data);

					});

				});

			});

		}
	
	});
	
}

function start(fleetRoleArn, ssmInstanceProfileArn, ImageId, SecurityGroupId, KeyName, cb) {

	var params = {
		SpotFleetRequestConfig: {
			IamFleetRole: fleetRoleArn,
			LaunchSpecifications: [
				{
					IamInstanceProfile: {
						Arn: ssmInstanceProfileArn
					}, 
					ImageId: ImageId,
					InstanceType: "g2.2xlarge",
					KeyName: KeyName,
					SecurityGroups: [ { GroupId: SecurityGroupId } ]
				}
			],
			Type: "request",
			SpotPrice: config.AWSMaxPrice || "0.4", 
			TargetCapacity: 1
		}
		
	};

	ec2.requestSpotFleet(params, function(err, data) {

		if (err) {
			reporter.report(err.stack, "error");
		} else {
			
			reporter.report("Request made: " +  data.SpotFleetRequestId);
			reporter.report("Now we wait for fulfillment...");

			var c = setInterval(function() {

				findSpotFleetInstances(data.SpotFleetRequestId, function(err, instances) {
					
					if(err) {
						reporter.report(err.stack);
						clearInterval(c);
					} else {

						if(instances.length > 0) {
							clearInterval(c);
							c = null;

							var instanceId = instances[0].InstanceId;

							reporter.report("Got an instance: " + instanceId);
							reporter.report("Tagging instance...");
							
							createTags(instanceId, function() {
								
								reporter.report("Tagged 'cloudrig'");

								reporter.report("Now we wait for our instance to be ready...");

								var v = setInterval(function() {

									getActiveInstances(function(err, instances) {
										
										if(instances.length > 0) {
											
											clearInterval(v);
											v = null;

											reporter.report("Now we wait for our instance to be OK...");

											ec2.waitFor('instanceStatusOk', {

												InstanceIds: [ instanceId ]
												
											}, function(err, data) {
												
												if (err) { 
													reporter.report(err.stack, "error")
												} else {
													reporter.report("Ready");
													cb(null);
												}

											});
										}

									});

								}, 5000);

							});
							
						}

					}
				});

			}, 5000);

		}
	});

	return params;

}

function stop(spotFleetRequestId, instanceId, cb) {

	reporter.report("Stopping: \t" + spotFleetRequestId);

	var params = {
		SpotFleetRequestIds: [spotFleetRequestId], 
		TerminateInstances: true
	};

	ec2.cancelSpotFleetRequests(params, function(err, data) {
		
		if (err) {
			reporter.report(err.stack, "error"); 
		} else {

			reporter.report("Waiting for instance to be terminated...");

			ec2.waitFor('instanceTerminated', {
				
				InstanceIds: [instanceId]

			}, function() {

				reporter.report("Terminated");
				cb();

			});
			
		}

	});

}

function getRequiredConfig() {
	return ["AWSCredentialsProfile", "AWSMaxPrice", "AWSRegion"]
}

function validateRequiredConfig(configValues, cb) {

	var testCredentials = new AWS.SharedIniFileCredentials({
		profile: configValues[0]
	});
	
	if(!credentials.accessKeyId) {
		cb(null, ["AWS profile not found"]);
	} else {
		cb(null, true);
	}

}

// http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/SSM.html#sendCommand-property
function sendMessage(commands, cb) {

	getState(function(err, state) {
		
		if(err) {
			cb(err);
			return;
		}

		var instanceId = state.activeInstances[0].InstanceId;

		var params = {
			DocumentName: "AWS-RunPowerShellScript",
			InstanceIds: [
				instanceId
			],
			ServiceRoleArn: settings.ssmRole,
			Parameters: {
				"commands": commands
			}
		};

		reporter.report("Sending '" + commands.join("' ") + "' to " + state.activeInstances[0].InstanceId);
		reporter.report(JSON.stringify(params, null, 4))

		ssm.sendCommand(params, function(err, data) {
			
			if(err) {
				cb(err);
				return;
			}

			function check() {

				reporter.report("Checking command '" + data.Command.CommandId + "'...");

				ssm.listCommandInvocations({
					CommandId: data.Command.CommandId, /* required */
					InstanceId: instanceId,
					Details: true
				}, function(err, data) {
					
					if(err) {
						cb(err);
						return;
					}
					
					// https://github.com/aws/aws-sdk-net/issues/535
					if(data.CommandInvocations && data.CommandInvocations.length > 0 && data.CommandInvocations[0].Status == "Success") {
						
						cb(null, data.CommandInvocations[0].CommandPlugins[0].Output);

					} else {

						setTimeout(check, 1000);
						
					}

				});

			}
			
			check();

		});
		

	});

}

function getState(cb) {
	
	async.parallel([
		
		getActiveInstances,
		getPendingInstances,
		getShuttingDownInstances

	], function(err, results) {
		
		if(err) {
			cb(err);
			return;
		}

		cb(null, {
			activeInstances: results[0],
			pendingInstances: results[1],
			shuttingDownInstances: results[2]
		});

	});

}


module.exports = {
	
	id: "AWS",

	setConfig: function(_config) {
		config = _config;
	},

	setReporter: function(_reporter) {
		reporter.set(_reporter, "AWS");
	},

	getPassword: function(cb) {
		
		getState(function(err, state) {

			if(err) {
				cb(err);
				return;
			}

			var instanceId = state.activeInstances[0].InstanceId;

			getPassword(instanceId, cb);

		});

	},

	// also reinit
	setup: function(cb) {
		
		credentials = new AWS.SharedIniFileCredentials({
			profile: config.AWSCredentialsProfile
		});
		
		AWS.config.credentials = credentials;
		AWS.config.region = config.AWSRegion;

		iam = new AWS.IAM();
		ec2 = new AWS.EC2();
		ssm = new AWS.SSM();
		
		async.parallel([
			findFleetRole,
			findSSMRole,
			findAMI,
			findSecurityGroup,
			findKeyPair
		], function(err, results) {

			if(err) {
				cb("Error " + err);
				return;
			}

			// http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/IAM.html#createRole-property
			var fleetRole = results[0];

			var ssmRole = results[1];

			// Choose AMI
			var AMI = results[2];

			// http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/EC2.html#createSecurityGroup-property
			var securityGroup = results[3];

			// http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/EC2.html#createKeyPair-property
			var keyPair = results[4];
			
			var questions = [];

			if(!fleetRole) {
				questions.push({
					q: "Shall I make a role called '" + fleetRoleName + "' for Spot Fleet requests?",
					m: createFleetRole.bind(this)
				});
			} else {
				settings.fleetRole = fleetRole.Arn;
			}

			if(!ssmRole || (ssmRole && !ssmRole.Role)) {
				questions.push({
					q: "Shall I make a role and instance profile called '" + ssmRoleName + "' for SSM communication?",
					m: createSSMRole.bind(this)
				});
			} else {
				settings.ssmInstanceProfile = ssmRole.InstanceProfile.Arn;
				settings.ssmRole = ssmRole.Role.Arn;
			}

			if(!AMI) {
				questions.push({
					q: "Shall I make an AMI based off the stock 'cloudrig' AMI?",
					m: createImage.bind(this)
				});
			} else {
				settings.ImageId = AMI.ImageId;
			}
			
			if(!keyPair) {
				questions.push({
					q: "Shall I make a Key Pair called 'cloudrig'?",
					m: function(cb) {

						createKeyPair((data) => {
							reporter.report("PEM stored at " + securityKeyPairPath);
							fs.writeFile(securityKeyPairPath, data.KeyMaterial, (err) => {
								cb(null);
							});
						})
					}.bind(this)
				});
			} else {
				settings.KeyName = keyPair.KeyName;
			}

			if(!securityGroup.GroupId) {
				questions.push({
					q: "Can I make a CloudRig security group for you?",
					m: createImage.bind(this)
				});
			} else {
				settings.SecurityGroupId = securityGroup.GroupId;
			}
			
			cb(null, questions, settings);

		});

	},

	sendMessage: sendMessage,

	getRequiredConfig: getRequiredConfig,

	validateRequiredConfig: validateRequiredConfig,

	validateRequiredSoftware: function(cb) {
		cb(null, true);
	},

	getState: getState,

	getActive: function(cb) {
		getActiveInstances(cb);
	},

	getPending: function(cb) {
		getPendingInstances(cb);
	},

	getShuttingDownInstances: function(cb) {
		getShuttingDownInstances(cb);
	},

	start: function(cb) {
		/*
		if(state.runningSpotInstance) {
			cb("You area already running an instance");
			return;	
		}
		*/
		return start(settings.fleetRole, settings.ssmInstanceProfile, settings.ImageId, settings.SecurityGroupId, settings.KeyName, cb);
	},

	stop: function(cb) {

		getState(function(err, state) {

			if(err) {
				cb(err);
				return;
			}

			var id;
			
			state.activeInstances[0].Tags.forEach(function(tag) {

				if(tag.Key === "aws:ec2spot:fleet-request-id") {
						id = tag.Value;
					}
				});

			stop(id, state.activeInstances[0].InstanceId, cb);

		});
		
		
	},

	getPublicDNS: function(cb) {

		getState(function(err, state) {
			if(err) {
				cb(err);
				return;
			}
			cb(null, state.activeInstances[0].PublicDnsName);
		});

	},

	update: function(cb) {

		getState(function(err, state) {
			
			if(err) {
				cb(err);
				return;
			}

			if(state.activeInstances.length > 0) {	
				updateImage(state.activeInstances[0].InstanceId, settings.ImageId, cb);
			} else {
				cb("There's no instance running...");
			}

		});

		

	},

	updateAndStop: function(cb) {

		updateImage(settings.ImageId, function() {
			stop(settings.ImageId, cb);	
		});

	},
	
	_createSecurityGroup: createSecurityGroup,

	_createKeyPair: createKeyPair,

}